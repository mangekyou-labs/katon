// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RFQRouter} from "../src/RFQRouter.sol";
import {TransparentUpgradeableProxy, ProxyAdmin} from "../src/TransparentProxy.sol";
import {TestBase} from "./TestBase.sol";

contract UpgradeGovernanceTest is TestBase {
    function testTransparentProxyInitializesThroughProxyAndPreservesStateAcrossUpgrade() public {
        address governance = address(0xBEEF);
        ProxyAdmin admin = new ProxyAdmin(governance);
        RFQRouter implementationV1 = new RFQRouter();
        bytes memory init = abi.encodeCall(RFQRouter.initialize, (governance, governance));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(implementationV1), address(admin), init);
        RFQRouter routed = RFQRouter(address(proxy));

        assertEq(routed.owner(), governance);
        assertEq(routed.feeRecipient(), governance);
        assertEq(proxy.admin(), address(admin));
        assertEq(proxy.implementation(), address(implementationV1));

        vm.prank(governance);
        routed.setProtocolFeeBps(50);
        assertEq(routed.protocolFeeBps(), 50);

        RFQRouter implementationV2 = new RFQRouter();
        vm.prank(governance);
        admin.upgradeAndCall(address(proxy), address(implementationV2), "");
        assertEq(proxy.implementation(), address(implementationV2));
        assertEq(routed.owner(), governance);
        assertEq(routed.protocolFeeBps(), 50);
    }

    function testProxyAdminCannotBeUsedByImplementationCallerAndOwnershipIsBounded() public {
        ProxyAdmin admin = new ProxyAdmin(address(this));
        RFQRouter implementation = new RFQRouter();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation), address(admin), abi.encodeCall(RFQRouter.initialize, (address(this), address(this)))
        );
        vm.expectRevert("PROXY_ADMIN_ONLY");
        proxy.upgradeToAndCall(address(implementation), "");
        vm.expectRevert("ONLY_OWNER");
        vm.prank(address(0xCAFE));
        admin.transferOwnership(address(0xD00D));
    }
}
