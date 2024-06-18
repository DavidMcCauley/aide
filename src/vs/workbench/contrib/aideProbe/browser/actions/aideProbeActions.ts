/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from 'vs/base/common/codicons';
import { KeyCode } from 'vs/base/common/keyCodes';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { basenameOrAuthority } from 'vs/base/common/resources';
import { ILocalizedString, localize2 } from 'vs/nls';
import { Action2, MenuId, registerAction2 } from 'vs/platform/actions/common/actions';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { registerWorkbenchContribution2, WorkbenchPhase } from 'vs/workbench/common/contributions';
import { IView } from 'vs/workbench/common/views';
import { showProbeView, VIEW_ID } from 'vs/workbench/contrib/aideProbe/browser/aideProbe';
import { CONTEXT_IN_PROBE_INPUT, CONTEXT_PROBE_INPUT_HAS_TEXT, CONTEXT_PROBE_REQUEST_IN_PROGRESS } from 'vs/workbench/contrib/aideProbe/browser/aideProbeContextKeys';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IViewsService } from 'vs/workbench/services/views/common/viewsService';

const PROBE_CATEGORY = localize2('aideProbe.category', 'AI Search');

export interface IProbeActionContext {
	view?: IView;
	inputValue?: string;
}

export class SubmitAction extends Action2 {
	static readonly ID = 'workbench.action.aideProbe.submit';

	constructor(title: ILocalizedString) {
		super({
			id: SubmitAction.ID,
			title,
			f1: false,
			category: PROBE_CATEGORY,
			icon: Codicon.send,
			precondition: ContextKeyExpr.and(CONTEXT_PROBE_INPUT_HAS_TEXT, CONTEXT_PROBE_REQUEST_IN_PROGRESS.negate()),
			keybinding: {
				when: CONTEXT_IN_PROBE_INPUT,
				primary: KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: [
				{
					id: MenuId.AideProbePrimary,
					group: 'navigation',
					when: CONTEXT_PROBE_REQUEST_IN_PROGRESS.negate(),
				}
			]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]) {
		const aideProbeView = await showProbeView(accessor.get(IViewsService));
		if (!aideProbeView) {
			return;
		}

		aideProbeView.acceptInput();
	}
}

class SubmitActionComposer extends Disposable {
	static readonly ID = 'workbench.action.aideProbe.submitComposer';
	private registeredAction: IDisposable;

	constructor(
		@IEditorService private readonly editorService: IEditorService
	) {
		super();
		this.registeredAction = registerAction2(class extends SubmitAction {
			constructor() {
				super(localize2('aideProbe.submitComposer.label', "Start search"));
			}
		});

		this._register(this.editorService.onDidActiveEditorChange(() => {
			const activeEditor = this.editorService.activeEditor;
			if (activeEditor?.resource) {
				this.registeredAction.dispose();
				const fileName = basenameOrAuthority(activeEditor.resource);
				const title = localize2('aideProbe.submit.label', "Start search from {0}", fileName);
				this.registeredAction = registerAction2(class extends SubmitAction {
					constructor() {
						super(title);
					}
				});
			}
		}));
	}
}

export class CancelAction extends Action2 {
	static readonly ID = 'workbench.action.aideProbe.cancel';

	constructor() {
		super({
			id: CancelAction.ID,
			title: localize2('aideProbe.cancel.label', "Cancel"),
			f1: false,
			category: PROBE_CATEGORY,
			icon: Codicon.x,
			precondition: CONTEXT_PROBE_REQUEST_IN_PROGRESS,
			keybinding: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib
			},
			menu: [
				{
					id: MenuId.AideProbePrimary,
					group: 'navigation',
					when: CONTEXT_PROBE_REQUEST_IN_PROGRESS,
				}
			]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]) {

		const aideProbeView = await showProbeView(accessor.get(IViewsService));
		if (!aideProbeView) {
			return;
		}

		aideProbeView.cancelRequest();
	}
}

export class ClearAction extends Action2 {
	static readonly ID = 'workbench.action.aideProbe.clear';

	constructor() {
		super({
			id: ClearAction.ID,
			title: localize2('aideProbe.clear.label', "Clear"),
			f1: false,
			category: PROBE_CATEGORY,
			icon: Codicon.clearAll,
			precondition: CONTEXT_PROBE_REQUEST_IN_PROGRESS.negate(),
			menu: [
				{
					id: MenuId.ViewTitle,
					group: 'navigation',
					order: 1,
					when: ContextKeyExpr.equals('view', VIEW_ID)
				}
			]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]) {
		const aideProbeView = await showProbeView(accessor.get(IViewsService));
		if (!aideProbeView) {
			return;
		}

		aideProbeView.clear();
	}
}

export function registerProbeActions() {
	registerAction2(CancelAction);
	registerAction2(ClearAction);
	registerWorkbenchContribution2(SubmitActionComposer.ID, SubmitActionComposer, WorkbenchPhase.BlockStartup);
}