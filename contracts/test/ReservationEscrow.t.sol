// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ReservationEscrow.sol";

interface Vm {
    function expectRevert(bytes4) external;
    function expectEmit(bool, bool, bool, bool) external;
    function warp(uint256) external;
    function prank(address) external;
}

contract MockUSDC is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfer;
    bool public failTransferFrom;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFailTransfer(bool value) external {
        failTransfer = value;
    }

    function setFailTransferFrom(bool value) external {
        failTransferFrom = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (failTransfer || balanceOf[msg.sender] < value) return false;
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (failTransferFrom || balanceOf[from] < value || allowance[from][msg.sender] < value) return false;
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract ReservationEscrowTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Reserved(bytes32 indexed offerId, address indexed buyer, address indexed seller, uint256 amount, bytes32 proofHash, uint64 refundAfter);
    event Released(bytes32 indexed offerId, address indexed seller, uint256 amount);
    event Refunded(bytes32 indexed offerId, address indexed buyer, uint256 amount);

    MockUSDC private token;
    ReservationEscrow private escrow;
    address private constant BUYER = address(0xB0B);
    address private constant SELLER = address(0x5E11E2);
    address private constant OTHER = address(0xBAD);
    uint256 private constant MAX = 100_000; // 0.10 USDC, 6 decimals
    uint256 private constant AMOUNT = 100_000;
    bytes32 private constant OFFER_ID = keccak256("offer-reshizard-95");
    bytes32 private constant PROOF_HASH = keccak256("proof");

    function setUp() public {
        token = new MockUSDC();
        escrow = new ReservationEscrow(address(token), MAX);
        token.mint(BUYER, 1_000_000);
        vm.prank(BUYER);
        token.approve(address(escrow), 1_000_000);
    }

    function testReserveSuccessAndEvent() public {
        uint64 refundAfter = uint64(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true);
        emit Reserved(OFFER_ID, BUYER, SELLER, AMOUNT, PROOF_HASH, refundAfter);
        _reserve(OFFER_ID, SELLER, AMOUNT, PROOF_HASH, refundAfter);
        (address buyer, address seller, uint256 amount, bytes32 proofHash, uint64 storedRefundAfter, ReservationEscrow.Status status) = escrow.reservations(OFFER_ID);
        _assertEq(buyer, BUYER);
        _assertEq(seller, SELLER);
        _assertEq(amount, AMOUNT);
        _assertEq(proofHash, PROOF_HASH);
        _assertEq(uint256(storedRefundAfter), uint256(refundAfter));
        _assertEq(uint256(status), uint256(ReservationEscrow.Status.Reserved));
        _assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function testReserveFailsWhenAllowanceInsufficient() public {
        vm.prank(BUYER);
        token.approve(address(escrow), AMOUNT - 1);
        vm.expectRevert(ReservationEscrow.TransferFailed.selector);
        _reserveDefault();
    }

    function testReserveFailsWhenBalanceInsufficient() public {
        vm.prank(address(0xC0FFEE));
        token.approve(address(escrow), AMOUNT);
        vm.expectRevert(ReservationEscrow.TransferFailed.selector);
        vm.prank(address(0xC0FFEE));
        escrow.reserve(OFFER_ID, SELLER, AMOUNT, PROOF_HASH, uint64(block.timestamp + 1 days));
    }

    function testReserveFailsAmountZero() public {
        vm.expectRevert(ReservationEscrow.InvalidAmount.selector);
        _reserve(OFFER_ID, SELLER, 0, PROOF_HASH, uint64(block.timestamp + 1 days));
    }

    function testReserveFailsAmountOverMax() public {
        vm.expectRevert(ReservationEscrow.InvalidAmount.selector);
        _reserve(OFFER_ID, SELLER, MAX + 1, PROOF_HASH, uint64(block.timestamp + 1 days));
    }

    function testReserveFailsSellerZero() public {
        vm.expectRevert(ReservationEscrow.InvalidAddress.selector);
        _reserve(OFFER_ID, address(0), AMOUNT, PROOF_HASH, uint64(block.timestamp + 1 days));
    }

    function testReserveFailsSellerBuyer() public {
        vm.expectRevert(ReservationEscrow.InvalidAddress.selector);
        _reserve(OFFER_ID, BUYER, AMOUNT, PROOF_HASH, uint64(block.timestamp + 1 days));
    }

    function testReserveFailsProofHashZero() public {
        vm.expectRevert(ReservationEscrow.InvalidAddress.selector);
        _reserve(OFFER_ID, SELLER, AMOUNT, bytes32(0), uint64(block.timestamp + 1 days));
    }

    function testReserveFailsRefundAfterInvalid() public {
        vm.expectRevert(ReservationEscrow.InvalidRefundTime.selector);
        _reserve(OFFER_ID, SELLER, AMOUNT, PROOF_HASH, uint64(block.timestamp));
    }

    function testReserveFailsDuplicateOfferId() public {
        _reserveDefault();
        vm.expectRevert(ReservationEscrow.AlreadyReserved.selector);
        _reserve(OFFER_ID, SELLER, AMOUNT, PROOF_HASH, uint64(block.timestamp + 2 days));
    }

    function testReleaseFailsForNonBuyer() public {
        _reserveDefault();
        vm.expectRevert(ReservationEscrow.OnlyBuyerCanRelease.selector);
        vm.prank(OTHER);
        escrow.release(OFFER_ID);
    }

    function testBuyerReleaseTransfersToSellerAndEmits() public {
        _reserveDefault();
        vm.expectEmit(true, true, false, true);
        emit Released(OFFER_ID, SELLER, AMOUNT);
        vm.prank(BUYER);
        escrow.release(OFFER_ID);
        _assertEq(token.balanceOf(SELLER), AMOUNT);
        (, , , , , ReservationEscrow.Status status) = escrow.reservations(OFFER_ID);
        _assertEq(uint256(status), uint256(ReservationEscrow.Status.Released));
    }

    function testRefundTooEarlyFails() public {
        _reserveDefault();
        vm.expectRevert(ReservationEscrow.RefundTooEarly.selector);
        escrow.refund(OFFER_ID);
    }

    function testRefundAfterExpiryTransfersToBuyerAndEmits() public {
        _reserveDefault();
        vm.warp(block.timestamp + 2 days);
        uint256 beforeBalance = token.balanceOf(BUYER);
        vm.expectEmit(true, true, false, true);
        emit Refunded(OFFER_ID, BUYER, AMOUNT);
        escrow.refund(OFFER_ID);
        _assertEq(token.balanceOf(BUYER), beforeBalance + AMOUNT);
        (, , , , , ReservationEscrow.Status status) = escrow.reservations(OFFER_ID);
        _assertEq(uint256(status), uint256(ReservationEscrow.Status.Refunded));
    }

    function testRepeatedReleaseOrRefundAfterStateTransitionFails() public {
        _reserveDefault();
        vm.prank(BUYER);
        escrow.release(OFFER_ID);
        vm.expectRevert(ReservationEscrow.NotReserved.selector);
        vm.prank(BUYER);
        escrow.release(OFFER_ID);
        vm.expectRevert(ReservationEscrow.NotReserved.selector);
        escrow.refund(OFFER_ID);
    }

    function testTransferFromReturningFalseFails() public {
        token.setFailTransferFrom(true);
        vm.expectRevert(ReservationEscrow.TransferFailed.selector);
        _reserveDefault();
    }

    function testTransferReturningFalseFailsOnRelease() public {
        _reserveDefault();
        token.setFailTransfer(true);
        vm.expectRevert(ReservationEscrow.TransferFailed.selector);
        vm.prank(BUYER);
        escrow.release(OFFER_ID);
    }

    function _reserveDefault() private {
        _reserve(OFFER_ID, SELLER, AMOUNT, PROOF_HASH, uint64(block.timestamp + 1 days));
    }

    function _reserve(bytes32 offerId, address seller, uint256 amount, bytes32 proofHash, uint64 refundAfter) private {
        vm.prank(BUYER);
        escrow.reserve(offerId, seller, amount, proofHash, refundAfter);
    }

    function _assertEq(address a, address b) private pure {
        require(a == b, "address mismatch");
    }

    function _assertEq(uint256 a, uint256 b) private pure {
        require(a == b, "uint mismatch");
    }

    function _assertEq(bytes32 a, bytes32 b) private pure {
        require(a == b, "bytes32 mismatch");
    }
}
