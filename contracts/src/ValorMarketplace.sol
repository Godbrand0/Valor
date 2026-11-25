// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "./ValorItems.sol";
import "./interfaces/IGoodDollar.sol";

interface IERC677Receiver {
    function onTokenTransfer(address from, uint256 value, bytes calldata data) external;
}

/// @title ValorMarketplace — Accepts G$ via transferAndCall or gasless permit relay
/// @notice Two purchase paths:
///   1. transferAndCall  — user calls G$.transferAndCall(marketplace, price, itemId) directly
///   2. purchaseWithPermit — user signs EIP-2612 permit off-chain; backend relays the tx (no CELO gas for user)
contract ValorMarketplace is IERC677Receiver, OwnableUpgradeable, ReentrancyGuard, UUPSUpgradeable {
    IGoodDollar public gToken;
    ValorItems public items;

    struct MarketItem {
        uint256 itemId;
        uint256 price;   // in G$ wei (18 decimals)
        bool active;
    }

    // onchain item id => MarketItem
    mapping(uint256 => MarketItem) public listings;
    uint256[] public listedItemIds;

    // Revenue accumulator — owner can withdraw
    uint256 public accumulatedRevenue;

    event ItemListed(uint256 indexed itemId, uint256 price);
    event ItemDelisted(uint256 indexed itemId);
    event ItemPurchased(address indexed buyer, uint256 indexed itemId, uint256 price);
    event RevenueWithdrawn(address indexed to, uint256 amount);

    error ItemNotListed();
    error InsufficientPayment(uint256 sent, uint256 required);
    error InvalidItemData();

    // ── Player-to-player resale (approval-based) ──────────────────────────────
    // Sellers keep custody of their ERC-1155 item and approve this contract as an
    // operator; on a sale the contract pulls G$ from the buyer, pays the seller
    // (minus a platform fee), and transfers the item seller -> buyer. New storage
    // is appended after the originals so the UUPS upgrade is layout-safe.
    struct ResaleListing {
        address seller;
        uint256 itemId;
        uint256 price;   // G$ wei the buyer pays
        bool active;
    }
    mapping(uint256 => ResaleListing) public resaleListings;
    uint256 public nextResaleId;
    uint256 public feeBps;                                  // platform fee, basis points (500 = 5%)
    uint256[] private _activeResaleIds;
    mapping(uint256 => uint256) private _activeIndexPlus1;  // resaleId => index+1 (0 = not active)

    event ResaleListed(uint256 indexed resaleId, address indexed seller, uint256 indexed itemId, uint256 price);
    event ResaleCancelled(uint256 indexed resaleId);
    event ResalePurchased(uint256 indexed resaleId, address indexed buyer, address seller, uint256 itemId, uint256 price, uint256 fee);
    event FeeBpsSet(uint256 bps);

    error ResaleNotActive();
    error NotSeller();
    error CannotBuyOwnListing();
    error InvalidPrice();
    error NotItemOwner();
    error MarketplaceNotApproved();
    error FeeTooHigh();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _gToken, address _items, address _owner) public initializer {
        __Ownable_init(_owner);
        gToken = IGoodDollar(_gToken);
        items = ValorItems(_items);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice One-time init for the resale upgrade — sets the default 5% fee.
    /// Called via upgradeToAndCall(newImpl, abi.encodeCall(initializeResale, ())).
    function initializeResale() public reinitializer(2) {
        feeBps = 500;
    }

    /// @notice Point the marketplace at a different payment token.
    ///
    /// @dev    Exists so that a payment token which has to be redeployed — moving
    ///         behind a proxy, say, which changes its address — can be repointed
    ///         without an upgrade carrying a hand-written storage write.
    ///
    ///         DANGEROUS IN THE OBVIOUS WAY. `accumulatedRevenue` is a bare number,
    ///         not a per-token balance, so switching the currency while revenue is
    ///         outstanding leaves that figure denominated in the OLD token while
    ///         `withdrawRevenue` pays in the new one. The require below refuses that
    ///         case rather than trusting an operator to remember it: withdraw first,
    ///         then switch.
    ///
    ///         Any resale listing priced in the old token also becomes mispriced, so
    ///         this is a maintenance-window operation, not a routine one.
    function setCurrency(address token) external onlyOwner {
        if (token == address(0)) revert InvalidItemData();
        require(accumulatedRevenue == 0, "withdraw revenue before switching currency");
        gToken = IGoodDollar(token);
        emit CurrencySet(token);
    }

    event CurrencySet(address indexed token);

    /// @notice Owner can tune the resale platform fee (max 20%).
    function setFeeBps(uint256 _bps) external onlyOwner {
        if (_bps > 2000) revert FeeTooHigh();
        feeBps = _bps;
        emit FeeBpsSet(_bps);
    }

    /// @notice Path 1 — called by the G$ ERC677 token on transferAndCall
    /// @param from  Buyer wallet
    /// @param value Amount of G$ sent (in wei)
    /// @param data  ABI-encoded uint256 itemId
    function onTokenTransfer(address from, uint256 value, bytes calldata data)
        external
        override
        nonReentrant
    {
        require(msg.sender == address(gToken), "Only G$ token");

        if (data.length < 32) revert InvalidItemData();
        uint256 itemId = abi.decode(data, (uint256));

        MarketItem storage listing = listings[itemId];
        if (!listing.active) revert ItemNotListed();
        if (value < listing.price) revert InsufficientPayment(value, listing.price);

        uint256 excess = value - listing.price;
        accumulatedRevenue += listing.price;

        if (excess > 0) {
            gToken.transfer(from, excess);
        }

        items.mint(from, itemId, 1);
        emit ItemPurchased(from, itemId, listing.price);
    }

    /// @notice Path 2 — gasless purchase via EIP-2612 permit
    /// @dev Caller (Valor backend) pays gas; buyer signs a permit off-chain so no CELO needed from them
    /// @param buyer    Player's wallet address
    /// @param itemId   On-chain item ID (must be listed)
    /// @param deadline Permit expiry (unix timestamp)
    /// @param v        Permit signature v
    /// @param r        Permit signature r
    /// @param s        Permit signature s
    function purchaseWithPermit(
        address buyer,
        uint256 itemId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        MarketItem storage listing = listings[itemId];
        if (!listing.active) revert ItemNotListed();

        uint256 price = listing.price;

        // Consume the permit — allows this contract to spend exactly `price` G$ from buyer
        IERC20Permit(address(gToken)).permit(buyer, address(this), price, deadline, v, r, s);

        // Pull G$ from buyer to this contract
        IERC20(address(gToken)).transferFrom(buyer, address(this), price);

        accumulatedRevenue += price;
        items.mint(buyer, itemId, 1);

        emit ItemPurchased(buyer, itemId, price);
    }

    // ── Gifting ───────────────────────────────────────────────────────────────
    // One player pays, another receives. Storage appended after every earlier
    // variable (the resale block above), so the UUPS upgrade is layout-safe.
    //
    // The G$ permit only says WHO PAYS and HOW MUCH; it says nothing about who
    // receives. So the payer also signs an EIP-712 `Gift` naming the recipient
    // and item, and the contract checks it — a relay (or anyone) submitting the
    // transaction can't redirect the gift. A per-payer nonce stops a gift
    // signature being replayed to buy the same gift twice.

    /// payer => next gift nonce
    mapping(address => uint256) public giftNonces;

    bytes32 public constant GIFT_TYPEHASH =
        keccak256("Gift(address payer,address recipient,uint256 itemId,uint256 nonce,uint256 deadline)");
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event ItemGifted(address indexed payer, address indexed recipient, uint256 indexed itemId, uint256 price);

    error GiftExpired();
    error InvalidGiftSignature();
    error CannotGiftSelf();
    error InvalidRecipient();

    /// @notice EIP-712 domain for `Gift` signatures. Computed on the fly (no
    ///         stored state, so adding it can't disturb the upgrade layout).
    function giftDomainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            _DOMAIN_TYPEHASH,
            keccak256(bytes("ValorMarketplace")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    /// @notice The digest the payer signs to gift `itemId` to `recipient`.
    function giftDigest(address payer, address recipient, uint256 itemId, uint256 nonce, uint256 deadline)
        public view returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(GIFT_TYPEHASH, payer, recipient, itemId, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", giftDomainSeparator(), structHash));
    }

    /// @notice Gasless gift: `payer` buys `itemId` and it is minted to `recipient`.
    /// @dev    Same relay shape as purchaseWithPermit (the caller pays gas), plus
    ///         `giftSig` — the payer's EIP-712 `Gift` signature over the recipient,
    ///         item, their current gift nonce and `deadline`.
    function giftWithPermit(
        address payer,
        address recipient,
        uint256 itemId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata giftSig
    ) external nonReentrant {
        if (recipient == address(0)) revert InvalidRecipient();
        if (recipient == payer) revert CannotGiftSelf();
        if (block.timestamp > deadline) revert GiftExpired();
        MarketItem storage listing = listings[itemId];
        if (!listing.active) revert ItemNotListed();

        uint256 nonce = giftNonces[payer];
        bytes32 digest = giftDigest(payer, recipient, itemId, nonce, deadline);
        // EOAs and ERC-1271 smart wallets alike.
        if (!SignatureChecker.isValidSignatureNow(payer, digest, giftSig)) revert InvalidGiftSignature();
        giftNonces[payer] = nonce + 1;

        uint256 price = listing.price;
        IERC20Permit(address(gToken)).permit(payer, address(this), price, deadline, v, r, s);
        IERC20(address(gToken)).transferFrom(payer, address(this), price);

        accumulatedRevenue += price;
        items.mint(recipient, itemId, 1);

        emit ItemGifted(payer, recipient, itemId, price);
    }

    function listItem(uint256 itemId, uint256 price) external onlyOwner {
        listings[itemId] = MarketItem({ itemId: itemId, price: price, active: true });
        listedItemIds.push(itemId);
        emit ItemListed(itemId, price);
    }

    function delistItem(uint256 itemId) external onlyOwner {
        listings[itemId].active = false;
        emit ItemDelisted(itemId);
    }

    function withdrawRevenue(address to) external onlyOwner nonReentrant {
        uint256 amount = accumulatedRevenue;
        accumulatedRevenue = 0;
        gToken.transfer(to, amount);
        emit RevenueWithdrawn(to, amount);
    }

    function getListedItemCount() external view returns (uint256) {
        return listedItemIds.length;
    }

    // ── Resale: list / cancel / buy ───────────────────────────────────────────

    /// @notice List an item you own for resale. Requires the item to be approved
    ///         to this contract (items.setApprovalForAll(marketplace, true)).
    function listForResale(uint256 itemId, uint256 price) external returns (uint256 resaleId) {
        if (price == 0) revert InvalidPrice();
        if (items.balanceOf(msg.sender, itemId) == 0) revert NotItemOwner();
        if (!items.isApprovedForAll(msg.sender, address(this))) revert MarketplaceNotApproved();

        resaleId = nextResaleId++;
        resaleListings[resaleId] = ResaleListing({ seller: msg.sender, itemId: itemId, price: price, active: true });
        _addActive(resaleId);
        emit ResaleListed(resaleId, msg.sender, itemId, price);
    }

    /// @notice Cancel your own active resale listing.
    function cancelResale(uint256 resaleId) external {
        ResaleListing storage l = resaleListings[resaleId];
        if (!l.active) revert ResaleNotActive();
        if (l.seller != msg.sender) revert NotSeller();
        l.active = false;
        _removeActive(resaleId);
        emit ResaleCancelled(resaleId);
    }

    /// @notice Buy a resale listing. Buyer must have approved this contract to spend
    ///         `price` G$ beforehand (standard ERC-20 allowance).
    function buyResale(uint256 resaleId) external nonReentrant {
        _executeResale(resaleId, msg.sender);
    }

    /// @notice Buy a resale listing gaslessly on the G$ allowance — the buyer signs
    ///         an EIP-2612 permit so no separate approve tx is needed.
    function buyResaleWithPermit(
        uint256 resaleId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        uint256 price = resaleListings[resaleId].price;
        IERC20Permit(address(gToken)).permit(msg.sender, address(this), price, deadline, v, r, s);
        _executeResale(resaleId, msg.sender);
    }

    function _executeResale(uint256 resaleId, address buyer) private {
        ResaleListing storage l = resaleListings[resaleId];
        if (!l.active) revert ResaleNotActive();
        if (buyer == l.seller) revert CannotBuyOwnListing();

        address seller = l.seller;
        uint256 itemId = l.itemId;
        uint256 price  = l.price;

        // Effects before interactions.
        l.active = false;
        _removeActive(resaleId);

        // The seller must still hold the item (they could have transferred it away).
        if (items.balanceOf(seller, itemId) == 0) revert NotItemOwner();

        // Pull G$ from the buyer, split the fee, pay the seller.
        IERC20(address(gToken)).transferFrom(buyer, address(this), price);
        uint256 fee = (price * feeBps) / 10000;
        uint256 toSeller = price - fee;
        accumulatedRevenue += fee;
        if (toSeller > 0) gToken.transfer(seller, toSeller);

        // Hand the item to the buyer.
        items.safeTransferFrom(seller, buyer, itemId, 1, "");

        emit ResalePurchased(resaleId, buyer, seller, itemId, price, fee);
    }

    function _addActive(uint256 resaleId) private {
        _activeResaleIds.push(resaleId);
        _activeIndexPlus1[resaleId] = _activeResaleIds.length; // index + 1
    }

    function _removeActive(uint256 resaleId) private {
        uint256 idxPlus1 = _activeIndexPlus1[resaleId];
        if (idxPlus1 == 0) return;
        uint256 idx = idxPlus1 - 1;
        uint256 lastIdx = _activeResaleIds.length - 1;
        if (idx != lastIdx) {
            uint256 lastId = _activeResaleIds[lastIdx];
            _activeResaleIds[idx] = lastId;
            _activeIndexPlus1[lastId] = idx + 1;
        }
        _activeResaleIds.pop();
        _activeIndexPlus1[resaleId] = 0;
    }

    /// @notice All active resale listings — the marketplace reads this to show what
    ///         other players are selling.
    function getActiveResales() external view returns (uint256[] memory ids, ResaleListing[] memory entries) {
        uint256 n = _activeResaleIds.length;
        ids = new uint256[](n);
        entries = new ResaleListing[](n);
        for (uint256 i; i < n; i++) {
            ids[i] = _activeResaleIds[i];
            entries[i] = resaleListings[_activeResaleIds[i]];
        }
    }

    function getActiveResaleCount() external view returns (uint256) {
        return _activeResaleIds.length;
    }
}
