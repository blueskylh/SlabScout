// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title ReservationEscrow
/// @notice Arc Testnet USDC escrow used by SlabScout. The contract only locks a refundable deposit; it never pays the full card price.
/// @dev USDC uses 6 decimals. App-layer policy must approve only authorized Arc Testnet amounts.
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

    event Reserved(bytes32 indexed offerId, address indexed buyer, address indexed seller, uint256 amount, bytes32 proofHash, uint64 refundAfter);
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

    function reserve(bytes32 offerId, address seller, uint256 amount, bytes32 proofHash, uint64 refundAfter) external {
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

        _safeTransferFrom(address(usdc), msg.sender, address(this), amount);
        emit Reserved(offerId, msg.sender, seller, amount, proofHash, refundAfter);
    }

    function release(bytes32 offerId) external {
        Reservation storage reservation = reservations[offerId];
        if (reservation.status != Status.Reserved) revert NotReserved();
        if (msg.sender != reservation.buyer) revert OnlyBuyerCanRelease();

        reservation.status = Status.Released;
        _safeTransfer(address(usdc), reservation.seller, reservation.amount);
        emit Released(offerId, reservation.seller, reservation.amount);
    }

    function refund(bytes32 offerId) external {
        Reservation storage reservation = reservations[offerId];
        if (reservation.status != Status.Reserved) revert NotReserved();
        if (block.timestamp < reservation.refundAfter) revert RefundTooEarly();

        reservation.status = Status.Refunded;
        _safeTransfer(address(usdc), reservation.buyer, reservation.amount);
        emit Refunded(offerId, reservation.buyer, reservation.amount);
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
