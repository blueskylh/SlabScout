// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ReservationEscrow.sol";

interface Vm {
    function envAddress(string calldata key) external view returns (address);
    function envUint(string calldata key) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployReservationEscrow {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address private constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (ReservationEscrow deployed) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Arc Testnet only");
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        uint256 maxReservationAmount = vm.envUint("MAX_RESERVATION_AMOUNT_USDC_6_DECIMALS");
        require(usdc == ARC_TESTNET_USDC, "wrong USDC");
        require(maxReservationAmount > 0 && maxReservationAmount <= 100_000, "max reservation must be <= 0.10 USDC");
        vm.startBroadcast();
        deployed = new ReservationEscrow(usdc, maxReservationAmount);
        vm.stopBroadcast();
    }
}
