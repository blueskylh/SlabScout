// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title ReservationEscrow
/// @notice Minimal Arc Testnet USDC escrow used by SlabScout's hackathon demo.
/// @dev USDC uses 6 decimals. App-layer policy must approve only authorized amounts.
contract ReservationEscrow {
    enum Status {
        None,
        Reserved,
        Released,
        Refunded
    }

    struct Reservation {
        address buyer;
        address seller;
        uint256 amount;
        bytes32 proofHash;
        uint64 refundAfter;
        Status status;
    }

    IERC20 public immutable usdc;
    uint256 public immutable maxReservationAmount;

    mapping(bytes32 => Reservation) public reservations;

    event Reserved(
        bytes32 indexed offerId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        bytes32 proofHash,
        uint64 refundAfter
    );
    event Released(bytes32 indexed offerId, address indexed seller, uint256 amount);
    event Refunded(bytes32 indexed offerId, address indexed buyer, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error AlreadyReserved();
    error NotReserved();
    error OnlyBuyerCanRelease();
    error RefundTooEarly();
    error InvalidRefundTime();
    error TransferFailed();

    constructor(address usdc_, uint256 maxReservationAmount_) {
        if (usdc_ == address(0)) revert InvalidAddress();
        if (maxReservationAmount_ == 0) revert InvalidAmount();
        usdc = IERC20(usdc_);
        maxReservationAmount = maxReservationAmount_;
    }

    function reserve(
        bytes32 offerId,
        address seller,
        uint256 amount,
        bytes32 proofHash,
        uint64 refundAfter
    ) external {
        if (offerId == bytes32(0) || seller == address(0) || seller == msg.sender) revert InvalidAddress();
        if (amount == 0 || amount > maxReservationAmount) revert InvalidAmount();
        if (proofHash == bytes32(0)) revert InvalidAddress();
        if (refundAfter <= block.timestamp) revert InvalidRefundTime();
        if (reservations[offerId].status != Status.None) revert AlreadyReserved();

        reservations[offerId] = Reservation({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            proofHash: proofHash,
            refundAfter: refundAfter,
            status: Status.Reserved
        });

        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Reserved(offerId, msg.sender, seller, amount, proofHash, refundAfter);
    }

    function release(bytes32 offerId) external {
        Reservation storage reservation = reservations[offerId];
        if (reservation.status != Status.Reserved) revert NotReserved();
        if (msg.sender != reservation.buyer) revert OnlyBuyerCanRelease();

        reservation.status = Status.Released;
        if (!usdc.transfer(reservation.seller, reservation.amount)) revert TransferFailed();
        emit Released(offerId, reservation.seller, reservation.amount);
    }

    function refund(bytes32 offerId) external {
        Reservation storage reservation = reservations[offerId];
        if (reservation.status != Status.Reserved) revert NotReserved();
        if (block.timestamp < reservation.refundAfter) revert RefundTooEarly();

        reservation.status = Status.Refunded;
        if (!usdc.transfer(reservation.buyer, reservation.amount)) revert TransferFailed();
        emit Refunded(offerId, reservation.buyer, reservation.amount);
    }
}
