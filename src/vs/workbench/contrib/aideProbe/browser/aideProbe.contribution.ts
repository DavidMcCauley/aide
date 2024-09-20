/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from 'vs/base/common/codicons';
import * as nls from 'vs/nls';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { Registry } from 'vs/platform/registry/common/platform';
import { registerIcon } from 'vs/platform/theme/common/iconRegistry';
import { ViewPaneContainer } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { registerWorkbenchContribution2, WorkbenchPhase } from 'vs/workbench/common/contributions';
import { IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions } from 'vs/workbench/common/views';
import { registerProbeActions } from 'vs/workbench/contrib/aideProbe/browser/actions/aideProbeActions';
import { AideControls } from 'vs/workbench/contrib/aideProbe/browser/aideControls';
import { AideControlsService, IAideControlsService } from 'vs/workbench/contrib/aideProbe/browser/aideControlsService';
import { AideLSPService, IAideLSPService } from 'vs/workbench/contrib/aideProbe/browser/aideLSPService';
import { VIEW_ID, VIEWLET_ID } from 'vs/workbench/contrib/aideProbe/browser/aideProbe';
import { AideProbeDecorationService } from 'vs/workbench/contrib/aideProbe/browser/aideProbeDecorations';
import { AideProbeExplanationService, IAideProbeExplanationService } from 'vs/workbench/contrib/aideProbe/browser/aideProbeExplanations';
import { AideProbeService, IAideProbeService } from 'vs/workbench/contrib/aideProbe/browser/aideProbeService';
import { AideProbeViewPane } from 'vs/workbench/contrib/aideProbe/browser/aideProbeView';

const probeViewIcon = registerIcon('probe-view-icon', Codicon.lightbulbSparkle, nls.localize('probeViewIcon', 'View icon of the AI search view.'));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEWLET_ID,
	title: nls.localize2('probe', "Aide"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	hideIfEmpty: true,
	icon: probeViewIcon,
	order: 1,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

const viewDescriptor: IViewDescriptor = {
	id: VIEW_ID,
	containerIcon: probeViewIcon,
	name: nls.localize2('probe', "Aide"),
	ctorDescriptor: new SyncDescriptor(AideProbeViewPane),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: viewContainer.id,
		order: 2
	},
};

// Register search default location to sidebar
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([viewDescriptor], viewContainer);

// Register actions
registerProbeActions();

// Register services
registerSingleton(IAideControlsService, AideControlsService, InstantiationType.Delayed);
registerSingleton(IAideLSPService, AideLSPService, InstantiationType.Eager);
registerSingleton(IAideProbeExplanationService, AideProbeExplanationService, InstantiationType.Delayed);
registerSingleton(IAideProbeService, AideProbeService, InstantiationType.Delayed);
registerWorkbenchContribution2(AideControls.ID, AideControls, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(AideProbeDecorationService.ID, AideProbeDecorationService, WorkbenchPhase.Eventually);