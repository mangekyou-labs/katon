// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {RFQRouter} from "../src/RFQRouter.sol";

contract RouterMockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract RouterMockSource {
    RouterMockERC20 public immutable sellToken;
    RouterMockERC20 public immutable buyToken;
    uint256 public immutable output;
    bool public shouldRevert;

    constructor(RouterMockERC20 sell, RouterMockERC20 buy, uint256 amount) {
        sellToken = sell;
        buyToken = buy;
        output = amount;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function execute(
        address seller,
        address expectedSellToken,
        address expectedBuyToken,
        uint256 sellAmount,
        uint256,
        bytes calldata
    ) external returns (uint256) {
        require(!shouldRevert, "SOURCE_FAILED");
        require(expectedSellToken == address(sellToken) && expectedBuyToken == address(buyToken), "PAIR");
        sellToken.transferFrom(seller, address(this), sellAmount);
        buyToken.transfer(msg.sender, output);
        return output;
    }
}

contract RouterReentrantSource {
    address public router;
    bytes public routeData;

    constructor(address router_) {
        router = router_;
    }

    function setRouteData(bytes calldata data) external {
        routeData = data;
    }

    function execute(address, address, address, uint256, uint256, bytes calldata) external returns (uint256) {
        (bool ok,) = router.call(routeData);
        require(ok, "REENTER_FAILED");
        return 0;
    }
}

contract RFQRouterTest is TestBase {
    address private seller = address(0xBEEF);
    RouterMockERC20 private rwa;
    RouterMockERC20 private usdx;
    RFQRouter private router;
    RouterMockSource private first;
    RouterMockSource private second;

    function setUp() public {
        rwa = new RouterMockERC20();
        usdx = new RouterMockERC20();
        router = new RFQRouter();
        first = new RouterMockSource(rwa, usdx, 11 ether);
        second = new RouterMockSource(rwa, usdx, 10 ether);
        rwa.mint(seller, 20 ether);
        usdx.mint(address(first), 11 ether);
        usdx.mint(address(second), 10 ether);
        vm.prank(seller);
        rwa.approve(address(first), type(uint256).max);
        vm.prank(seller);
        rwa.approve(address(second), type(uint256).max);
        router.setSource(address(first), true);
        router.setSource(address(second), true);
        router.setLegacyRouteEnabled(true);
    }

    function testLegacyExecuteRouteIsDisabledByDefaultUntilExplicitlyEnabled() public {
        RFQRouter fresh = new RFQRouter();
        assertTrue(!fresh.legacyRouteEnabled());
        fresh.setLegacyRouteEnabled(true);
        assertTrue(fresh.legacyRouteEnabled());
    }

    function testExecutesAllowlistedBlendedRouteAndEnforcesAggregateMinimum() public {
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](2);
        legs[0] = RFQRouter.Leg(address(first), 10 ether, 10 ether, "");
        legs[1] = RFQRouter.Leg(address(second), 10 ether, 9 ether, "");
        RFQRouter.RoutePlan memory route = _route(20 ether, 19 ether, legs);

        vm.prank(seller);
        router.executeRoute(route);

        assertEq(rwa.balanceOf(seller), 0);
        assertEq(usdx.balanceOf(seller), 21 ether);
    }

    function testRejectsUnallowlistedSource() public {
        RouterMockSource injected = new RouterMockSource(rwa, usdx, 20 ether);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(injected), 20 ether, 20 ether, "");
        vm.expectRevert(bytes("SOURCE_NOT_ALLOWED"));
        vm.prank(seller);
        router.executeRoute(_route(20 ether, 20 ether, legs));
    }

    function testRevertsEveryLegWhenOneSourceFails() public {
        first.setShouldRevert(true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](2);
        legs[0] = RFQRouter.Leg(address(first), 10 ether, 10 ether, "");
        legs[1] = RFQRouter.Leg(address(second), 10 ether, 9 ether, "");
        vm.expectRevert(bytes("SOURCE_CALL_FAILED"));
        vm.prank(seller);
        router.executeRoute(_route(20 ether, 19 ether, legs));
        assertEq(rwa.balanceOf(seller), 20 ether);
        assertEq(usdx.balanceOf(seller), 0);
    }

    function testRejectsRouteCommitmentReplay() public {
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(first), 20 ether, 11 ether, "");
        RFQRouter.RoutePlan memory route = _route(20 ether, 11 ether, legs);

        vm.prank(seller);
        router.executeRoute(route);

        vm.expectRevert(bytes("COMMITMENT_REPLAY"));
        vm.prank(seller);
        router.executeRoute(route);
    }

    function testRejectsStaleDecisionBlock() public {
        router.setSnapshotPolicy(0, false);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(first), 20 ether, 11 ether, "");
        RFQRouter.RoutePlan memory route = _route(20 ether, 11 ether, legs);
        route.decisionBlock = 0;

        vm.expectRevert(bytes("SNAPSHOT_STALE"));
        vm.prank(seller);
        router.executeRoute(route);
    }

    function testRejectsMismatchedRequiredDecisionBlockHash() public {
        router.setSnapshotPolicy(256, true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(first), 20 ether, 11 ether, "");
        RFQRouter.RoutePlan memory route = _route(20 ether, 11 ether, legs);
        route.decisionBlock = block.number == 0 ? 0 : block.number - 1;
        route.decisionBlockHash = bytes32(uint256(123));

        vm.expectRevert(bytes("SNAPSHOT_HASH"));
        vm.prank(seller);
        router.executeRoute(route);
    }

    function testRejectsReentrantSourceExecution() public {
        RouterReentrantSource attacker = new RouterReentrantSource(address(router));
        router.setSource(address(attacker), true);
        RFQRouter.Leg[] memory legs = new RFQRouter.Leg[](1);
        legs[0] = RFQRouter.Leg(address(attacker), 1 ether, 0, "");
        RFQRouter.RoutePlan memory route = _route(1 ether, 0, legs);
        attacker.setRouteData(abi.encodeWithSelector(router.executeRoute.selector, route));

        vm.expectRevert(bytes("SOURCE_CALL_FAILED"));
        vm.prank(seller);
        router.executeRoute(route);
    }

    function _route(uint256 sellAmount, uint256 minOutput, RFQRouter.Leg[] memory legs)
        private
        view
        returns (RFQRouter.RoutePlan memory)
    {
        return RFQRouter.RoutePlan({
            chainId: block.chainid,
            router: address(router),
            commitment: bytes32(uint256(1)),
            decisionBlock: block.number,
            decisionBlockHash: bytes32(0),
            deadline: block.timestamp + 1 hours,
            sellToken: address(rwa),
            buyToken: address(usdx),
            sellAmount: sellAmount,
            minOutput: minOutput,
            legs: legs
        });
    }
}
