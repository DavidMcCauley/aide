/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension, IDomPosition } from 'vs/base/browser/dom';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IContextKeyService, IScopedContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IEditorOptions } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { editorBackground, editorForeground, inputBackground } from 'vs/platform/theme/common/colorRegistry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { EditorPane } from 'vs/workbench/browser/parts/editor/editorPane';
import { IEditorOpenContext } from 'vs/workbench/common/editor';
import { Memento } from 'vs/workbench/common/memento';
import { AideChatEditorInput } from 'vs/workbench/contrib/aideChat/browser/aideChatEditorInput';
import { AideChatWidget, IAideChatViewState } from 'vs/workbench/contrib/aideChat/browser/aideChatWidget';
import { IAideChatModel } from 'vs/workbench/contrib/aideChat/common/aideChatModel';
import { IEditorGroup } from 'vs/workbench/services/editor/common/editorGroupsService';

export interface IAideChatEditorOptions extends IEditorOptions {
	target?: { sessionId: string };
}

export class AideChatEditor extends EditorPane {
	private widget!: AideChatWidget;

	private _scopedContextKeyService!: IScopedContextKeyService;
	override get scopedContextKeyService() {
		return this._scopedContextKeyService;
	}

	private _memento: Memento | undefined;
	private _viewState: IAideChatViewState | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super(AideChatEditorInput.EditorID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._scopedContextKeyService = this._register(this.contextKeyService.createScoped(parent));
		const scopedInstantiationService = this.instantiationService.createChild(new ServiceCollection([IContextKeyService, this.scopedContextKeyService]));

		this.widget = this._register(scopedInstantiationService.createInstance(
			AideChatWidget,
			{},
			{
				listForeground: editorForeground,
				listBackground: editorBackground,
				inputEditorBackground: inputBackground,
				resultEditorBackground: editorBackground
			},
		));
		this.widget.render(parent);
		this.widget.setVisible(true);
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);

		this.widget?.setVisible(visible);
	}

	override async setInput(input: AideChatEditorInput, options: IAideChatEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		super.setInput(input, options, context, token);

		const editorModel = await input.resolve();
		if (!editorModel) {
			throw new Error(`Failed to get model for chat editor. id: ${input.sessionId}`);
		}

		if (!this.widget) {
			throw new Error('ChatEditor lifecycle issue: no editor widget');
		}

		this.updateModel(editorModel.model, options?.viewState ?? input.options.viewState);
	}

	private updateModel(model: IAideChatModel, viewState?: IAideChatViewState): void {
		this._memento = new Memento('aide-chat-editor', this.storageService);
		this._viewState = viewState ?? this._memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE) as IAideChatViewState;
		this.widget.setModel(model, { ...this._viewState });
	}

	override layout(dimension: Dimension, position?: IDomPosition): void {
		if (this.widget) {
			this.widget.layout(dimension.height, dimension.width);
		}
	}
}