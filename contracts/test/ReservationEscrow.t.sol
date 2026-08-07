// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ReservationEscrow.sol";

contract MockUSDC is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "BALANCE");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "BALANCE");
        require(allowance[from][msg.sender] >= value, "ALLOWANCE");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @notice Lightweight Solidity fixture documenting the intended Foundry checks.
/// Assertions are intentionally framework-agnostic so teams can port to Foundry
/// or Hardhat quickly during the hackathon.
contract ReservationEscrowFixture {
    MockUSDC public token;
    ReservationEscrow public escrow;

    function setUp() public {
        token = new MockUSDC();
        escrow = new ReservationEscrow(address(token), 500_000); // 0.5 USDC, 6 decimals
        token.mint(address(this), 1_000_000);
        token.approve(address(escrow), 500_000);
    }

    function reserveHappyPath(bytes32 offerId, address seller, bytes32 proofHash) public {
        escrow.reserve(offerId, seller, 100_000, proofHash, uint64(block.timestamp + 1 days));
    }
}
