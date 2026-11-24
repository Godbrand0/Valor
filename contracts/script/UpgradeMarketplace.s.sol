// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ValorMarketplace.sol";

/// @notice Deploys a new ValorMarketplace implementation for a UUPS upgrade.
///
/// The proxy is owned by the Safe (see UPGRADEABILITY.md), so this script does
/// NOT upgrade anything itself: it deploys the implementation and prints the
/// exact `upgradeToAndCall` to propose in the Safe UI.
///
/// Current upgrade: gifting (`giftWithPermit`, `giftNonces`, EIP-712 `Gift`).
/// Storage is appended only (`giftNonces` takes the next free slot) and needs no
/// one-off setup, so the call data is empty. Do NOT pass initializeResale again:
/// it is reinitializer(2), already run on Celo, and would revert.
///
/// Required env vars (contracts/.env or shell):
///   DEPLOYER_PRIVATE_KEY   — any funded key; it only deploys the implementation
///   MARKETPLACE_CONTRACT   — proxy address (0x95D167f569cf05C967C0432e3123baeac5D8d78D)
///   CELO_RPC_URL           — https://forno.celo.org
///
/// Run:
///   forge script script/UpgradeMarketplace.s.sol \
///     --rpc-url $CELO_RPC_URL \
///     --broadcast \
///     --verify
contract UpgradeMarketplace is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address proxy       = vm.envAddress("MARKETPLACE_CONTRACT");

        console.log("Proxy:    %s", proxy);
        console.log("Deployer: %s", vm.addr(deployerKey));

        vm.startBroadcast(deployerKey);
        ValorMarketplace newImpl = new ValorMarketplace();
        vm.stopBroadcast();

        console.log("New impl: %s", address(newImpl));
        console.log("");
        console.log("Propose in the Safe UI, to the PROXY (%s):", proxy);
        console.log("  upgradeToAndCall(%s, 0x)", address(newImpl));
        console.log("Raw calldata:");
        console.logBytes(abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(newImpl), "")));
    }
}
