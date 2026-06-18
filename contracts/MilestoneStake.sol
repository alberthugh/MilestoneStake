// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MilestoneStake — programmable milestone escrow for project teams
/// @notice A CUSTOMER opens an escrow with a named CONTRACTOR: a pool of native USDC split across N
///         milestones, each with a weight (share of the pool) and a hard deadline. The customer funds the
///         pool up front, so the contractor has guaranteed funds on-chain before starting. As each milestone
///         is delivered, the customer confirms it; then anyone (in practice a validator agent) resolves it:
///         confirmed on time → that milestone's share is released to the contractor; confirmed late → a
///         bounded penalty of the share is redirected to the customer (delay insurance) and the rest goes to
///         the contractor; never delivered past the deadline → the whole share refunds to the customer.
///         Milestones resolve strictly in order. Every payout is pull-based (parties withdraw from a shared
///         ledger), so the escrow can never be locked by a reverting recipient. No owner, no admin, no fee,
///         no custody — only the two named parties (plus permissionless time-based settlement) ever move the
///         money. Built for ARC: native-USDC micro-shares and cent-scale penalty splits, settled by agents.
contract MilestoneStake {
    uint8 public constant PENDING = 0;
    uint8 public constant ACTIVE = 1;
    uint8 public constant DONE = 2;
    uint8 public constant CANCELLED = 3;

    uint8 public constant M_OPEN = 0;
    uint8 public constant M_RELEASED = 1;
    uint8 public constant M_PENALIZED = 2;

    uint16 public constant MAX_PENALTY_BPS = 5000; // 50% cap
    uint8 public constant MAX_MILESTONES = 24;
    uint256 public constant MAX_TITLE = 80;

    struct Escrow {
        uint256 id;
        address customer;
        address contractor;
        string title;
        uint256 customerStake;
        uint256 contractorStake;
        uint256 pool;          // customerStake + contractorStake
        uint256 distributed;   // released + penalized so far
        uint256 relAmt;        // lifetime released to contractor (this escrow)
        uint256 penAmt;        // lifetime redirected to customer (this escrow)
        uint16 penaltyBps;
        uint8 n;
        uint8 resolved;        // milestones resolved (the current one == resolved)
        uint8 status;
        bool customerFunded;
        bool contractorFunded;
        uint64 createdAt;
    }

    struct Milestone {
        uint16 weightBps;
        uint64 deadline;
        uint64 confirmedAt;
        bool confirmed;
        uint8 state;           // OPEN / RELEASED / PENALIZED
    }

    uint256 public escrowCount;
    uint256 public totalPool;
    uint256 public totalReleased;
    uint256 public totalPenalized;
    uint256 public totalRefunded;

    mapping(uint256 => Escrow) public escrows;
    mapping(uint256 => mapping(uint8 => Milestone)) private _ms;
    mapping(address => uint256) public claimable; // shared pull-ledger
    mapping(address => uint256[]) private _asCustomer;
    mapping(address => uint256[]) private _asContractor;

    event EscrowCreated(uint256 indexed id, address indexed customer, address indexed contractor, string title, uint256 pool, uint8 n);
    event Funded(uint256 indexed id, address indexed who, uint256 amount, bool active);
    event Confirmed(uint256 indexed id, uint8 milestone, uint64 at);
    event Resolved(uint256 indexed id, uint8 milestone, uint8 state, uint256 toContractor, uint256 toCustomer);
    event Claimed(address indexed who, uint256 amount);
    event Cancelled(uint256 indexed id, uint256 refunded);

    /// @notice Customer opens an escrow (terms only — funding is a separate step). contractorStake is kept
    ///         in the shape for flexibility; the product uses 0 (single-sided, customer-funded).
    function createEscrow(
        address contractor,
        string calldata title,
        uint256 customerStake,
        uint256 contractorStake,
        uint16 penaltyBps,
        uint16[] calldata weightsBps,
        uint64[] calldata deadlines
    ) external returns (uint256) {
        require(contractor != address(0) && contractor != msg.sender, "bad contractor");
        require(bytes(title).length > 0 && bytes(title).length <= MAX_TITLE, "bad title");
        uint256 n = weightsBps.length;
        require(n >= 1 && n <= MAX_MILESTONES && deadlines.length == n, "bad milestones");
        require(penaltyBps <= MAX_PENALTY_BPS, "penalty too high");
        uint256 pool = customerStake + contractorStake;
        require(pool > 0, "empty pool");

        uint256 sum;
        uint64 prev;
        for (uint256 i = 0; i < n; i++) {
            require(weightsBps[i] >= 1 && weightsBps[i] <= 10000, "bad weight");
            require(deadlines[i] > block.timestamp && deadlines[i] > prev, "bad deadline");
            prev = deadlines[i];
            sum += weightsBps[i];
        }
        require(sum == 10000, "weights != 100%");

        uint256 id = ++escrowCount;
        Escrow storage e = escrows[id];
        e.id = id;
        e.customer = msg.sender;
        e.contractor = contractor;
        e.title = title;
        e.customerStake = customerStake;
        e.contractorStake = contractorStake;
        e.pool = pool;
        e.penaltyBps = penaltyBps;
        e.n = uint8(n);
        e.status = PENDING;
        e.createdAt = uint64(block.timestamp);
        if (customerStake == 0) e.customerFunded = true;
        if (contractorStake == 0) e.contractorFunded = true;

        for (uint8 i = 0; i < n; i++) {
            _ms[id][i] = Milestone({ weightBps: weightsBps[i], deadline: deadlines[i], confirmedAt: 0, confirmed: false, state: M_OPEN });
        }

        _asCustomer[msg.sender].push(id);
        _asContractor[contractor].push(id);
        emit EscrowCreated(id, msg.sender, contractor, title, pool, uint8(n));
        return id;
    }

    /// @notice Fund your side of the pool (native USDC). Activates the escrow once both required sides are in.
    function fund(uint256 id) external payable {
        Escrow storage e = escrows[id];
        require(e.status == PENDING, "not pending");
        if (msg.sender == e.customer && !e.customerFunded) {
            require(msg.value == e.customerStake, "send customerStake");
            e.customerFunded = true;
        } else if (msg.sender == e.contractor && !e.contractorFunded) {
            require(msg.value == e.contractorStake, "send contractorStake");
            e.contractorFunded = true;
        } else {
            revert("nothing to fund");
        }
        bool active = e.customerFunded && e.contractorFunded;
        if (active) { e.status = ACTIVE; totalPool += e.pool; }
        emit Funded(id, msg.sender, msg.value, active);
    }

    /// @notice Customer attests the current milestone was delivered (no money moves — penalty is judged at resolve).
    function confirmMilestone(uint256 id, uint8 i) external {
        Escrow storage e = escrows[id];
        require(e.customer == msg.sender, "not customer");
        require(e.status == ACTIVE, "not active");
        require(i == e.resolved, "out of order");
        Milestone storage m = _ms[id][i];
        require(m.state == M_OPEN && !m.confirmed, "already done");
        m.confirmed = true;
        m.confirmedAt = uint64(block.timestamp);
        emit Confirmed(id, i, m.confirmedAt);
    }

    /// @notice Resolve the current milestone — permissionless (the validator agent or either party).
    ///         On time → release to contractor; late → penalty to customer + rest to contractor;
    ///         never delivered past deadline → full share to customer.
    function releaseOrPenalize(uint256 id, uint8 i) external {
        Escrow storage e = escrows[id];
        require(e.status == ACTIVE, "not active");
        require(i == e.resolved, "out of order");
        Milestone storage m = _ms[id][i];
        require(m.state == M_OPEN, "resolved");
        bool late = block.timestamp > m.deadline;
        require(m.confirmed || late, "not due yet");

        uint256 share = (e.resolved == e.n - 1) ? (e.pool - e.distributed) : (e.pool * m.weightBps) / 10000;
        uint256 toContractor;
        uint256 toCustomer;

        if (m.confirmed && m.confirmedAt <= m.deadline) {
            // delivered on time
            m.state = M_RELEASED;
            toContractor = share;
        } else if (m.confirmed) {
            // delivered, but late → bounded penalty to the customer
            m.state = M_PENALIZED;
            toCustomer = (share * e.penaltyBps) / 10000;
            toContractor = share - toCustomer;
        } else {
            // never delivered, deadline passed → full refund of this share to the customer
            m.state = M_PENALIZED;
            toCustomer = share;
        }

        // effects (checks-effects-interactions; payouts are pull-based)
        e.distributed += share;
        if (toContractor > 0) { claimable[e.contractor] += toContractor; e.relAmt += toContractor; totalReleased += toContractor; }
        if (toCustomer > 0) { claimable[e.customer] += toCustomer; e.penAmt += toCustomer; totalPenalized += toCustomer; }
        e.resolved += 1;
        if (e.resolved == e.n) e.status = DONE;
        emit Resolved(id, i, m.state, toContractor, toCustomer);
    }

    /// @notice Withdraw everything owed to you across all escrows (single external call, post-zeroing).
    function claim() external {
        uint256 amt = claimable[msg.sender];
        require(amt > 0, "nothing to claim");
        claimable[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amt}("");
        require(ok, "claim failed");
        emit Claimed(msg.sender, amt);
    }

    /// @notice Cancel a not-yet-active escrow — refunds whatever was funded (so a no-show counterparty can't lock funds).
    function cancel(uint256 id) external {
        Escrow storage e = escrows[id];
        require(msg.sender == e.customer || msg.sender == e.contractor, "not a party");
        require(e.status == PENDING, "not pending");
        uint256 refunded;
        if (e.customerFunded && e.customerStake > 0) { claimable[e.customer] += e.customerStake; refunded += e.customerStake; }
        if (e.contractorFunded && e.contractorStake > 0) { claimable[e.contractor] += e.contractorStake; refunded += e.contractorStake; }
        e.status = CANCELLED;
        totalRefunded += refunded;
        emit Cancelled(id, refunded);
    }

    // ── views ───────────────────────────────────────────────
    function getEscrow(uint256 id) external view returns (Escrow memory) { return escrows[id]; }
    function getMilestone(uint256 id, uint8 i) external view returns (Milestone memory) { return _ms[id][i]; }

    function milestonesOf(uint256 id) external view returns (Milestone[] memory list) {
        uint8 n = escrows[id].n;
        list = new Milestone[](n);
        for (uint8 i = 0; i < n; i++) list[i] = _ms[id][i];
    }

    function shareOf(uint256 id, uint8 i) external view returns (uint256) {
        Escrow storage e = escrows[id];
        if (i == e.n - 1) {
            uint256 acc;
            for (uint8 k = 0; k < e.n - 1; k++) acc += (e.pool * _ms[id][k].weightBps) / 10000;
            return e.pool - acc;
        }
        return (e.pool * _ms[id][i].weightBps) / 10000;
    }

    /// @notice The auditor's report: pool, released-to-contractor, penalized-to-customer, remaining.
    function report(uint256 id) external view returns (uint256 pool, uint256 released, uint256 penalized, uint256 remaining) {
        Escrow storage e = escrows[id];
        return (e.pool, e.relAmt, e.penAmt, e.pool - e.distributed);
    }

    function escrowsOfCustomer(address who) external view returns (uint256[] memory) { return _asCustomer[who]; }
    function escrowsOfContractor(address who) external view returns (uint256[] memory) { return _asContractor[who]; }
}
