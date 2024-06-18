/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { DisposableStore, IDisposable } from 'vs/base/common/lifecycle';
import 'vs/css!./media/aideProbe';
import 'vs/css!./media/aideProbeExplanationWidget';
import 'vs/css!./media/probeBreakdownHover';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditor/codeEditorWidget';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IHoverService } from 'vs/platform/hover/browser/hover';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IViewPaneOptions, ViewPane } from 'vs/workbench/browser/parts/views/viewPane';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import { CONTEXT_PROBE_REQUEST_IN_PROGRESS } from 'vs/workbench/contrib/aideProbe/browser/aideProbeContextKeys';
import { AideChatBreakdowns } from 'vs/workbench/contrib/aideProbe/browser/aideProbeBreakdowns';
import { AideProbeInputPart } from 'vs/workbench/contrib/aideProbe/browser/aideProbeInputPart';
import { IAideProbeBreakdownContent, IAideProbeService } from 'vs/workbench/contrib/aideProbe/common/aideProbeService';
import { ResourceLabels } from 'vs/workbench/browser/labels';
import { MarkdownRenderer } from 'vs/editor/browser/widget/markdownRenderer/browser/markdownRenderer';
import { ChatMarkdownRenderer } from 'vs/workbench/contrib/aideChat/browser/aideChatMarkdownRenderer';
import { AideChatBreakdownViewModel, AideProbeViewModel } from 'vs/workbench/contrib/aideProbe/common/aideProbeViewModel';
import { Event } from 'vs/base/common/event';

const $ = dom.$;

export class AideProbeViewPane extends ViewPane {
	private container!: HTMLElement;
	private explorationDetail!: HTMLElement;
	private breakdownsListContainer!: HTMLElement;
	private responseWrapper!: HTMLElement;

	private inputPart!: AideProbeInputPart;

	private readonly markdownRenderer: MarkdownRenderer;
	private requestInProgress: IContextKey<boolean>;
	private _breakdownsList: AideChatBreakdowns;
	private readonly _resourceLabels: ResourceLabels;

	private readonly viewModelDisposables = this._register(new DisposableStore());
	private _viewModel: AideProbeViewModel | undefined;
	private set viewModel(viewModel: AideProbeViewModel | undefined) {
		if (this._viewModel === viewModel) {
			return;
		}

		this.viewModelDisposables.clear();

		this._viewModel = viewModel;
		if (viewModel) {
			this.viewModelDisposables.add(viewModel);
		} else {
			this.viewModel?.dispose();
			this.viewModelDisposables.clear();
		}
	}

	get viewModel(): AideProbeViewModel | undefined {
		return this._viewModel;
	}

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IAideProbeService private readonly aideProbeService: IAideProbeService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);
		this.requestInProgress = CONTEXT_PROBE_REQUEST_IN_PROGRESS.bindTo(contextKeyService);

		this._resourceLabels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));
		this._breakdownsList = this._register(this.instantiationService.createInstance(AideChatBreakdowns, this._resourceLabels));
		this.markdownRenderer = this._register(this.instantiationService.createInstance(ChatMarkdownRenderer, undefined));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.container = dom.append(container, $('.aide-probe-view'));

		this.inputPart = this._register(this.instantiationService.createInstance(AideProbeInputPart));
		this.inputPart.render(this.container, this);

		const breakdownsWrapper = dom.append(this.container, $('.breakdownsWrapper'));
		this.explorationDetail = dom.append(breakdownsWrapper, $('span.exploration-detail'));
		dom.append(breakdownsWrapper, $('span.chat-animated-ellipsis'));
		this.breakdownsListContainer = dom.append(breakdownsWrapper, $('.breakdownsListContainer'));

		this.responseWrapper = dom.append(this.container, $('.responseWrapper'));

		this.onDidChangeItems();
	}

	override focus(): void {
		super.focus();
	}

	getInputEditor(): CodeEditorWidget {
		return this.inputPart.inputEditor;
	}

	getInput(): string {
		if (this.viewModel) {
			this.requestInProgress.set(this.viewModel.requestInProgress);
		}
		return this.inputPart.inputEditor.getValue();
	}

	acceptInput() {
		this._acceptInput();
	}

	private _acceptInput() {
		if (this.viewModel?.requestInProgress) {
			return;
		} else if (this.viewModel) {
			this.clear();
		}

		const model = this.aideProbeService.startSession();
		this.viewModel = this.instantiationService.createInstance(AideProbeViewModel, model);
		this.viewModelDisposables.add(Event.accumulate(this.viewModel.onDidChange, 0)(() => {
			if (!this.viewModel) {
				return;
			}

			this.onDidChangeItems();
			this.requestInProgress.set(this.viewModel.requestInProgress);
		}));

		const editorValue = this.getInput();
		const result = this.aideProbeService.initiateProbe(this.viewModel.model, editorValue);

		if (result) {
			this.inputPart.acceptInput(editorValue);
			return result.responseCreatedPromise;
		}

		return undefined;
	}

	private onDidChangeItems(): void {
		this.updateExplorationDetail();
		if ((this.viewModel?.model.response?.breakdowns.length) ?? 0 > 0) {
			this._register(this.renderBreakdownsListData(this.viewModel?.model.response?.breakdowns ?? [], this.breakdownsListContainer));
			dom.show(this.breakdownsListContainer);
		} else {
			this._breakdownsList.hide();
			dom.hide(this.breakdownsListContainer);
		}
		this.renderFinalAnswer();
	}

	private updateExplorationDetail(): void {
		dom.clearNode(this.explorationDetail);
		if (this.requestInProgress.get()) {
			this.explorationDetail.textContent = 'Exploring the codebase';
		}
	}

	private renderBreakdownsListData(breakdowns: ReadonlyArray<IAideProbeBreakdownContent>, container: HTMLElement): IDisposable {
		const listDisposables = new DisposableStore();
		this._breakdownsList.show(container);
		const listData = breakdowns.map((item) => {
			const viewItem = this.instantiationService.createInstance(AideChatBreakdownViewModel, item);
			listDisposables.add(viewItem);
			return viewItem;
		});
		this._breakdownsList.updateBreakdowns(listData);

		return listDisposables;
	}

	private renderFinalAnswer(): void {
		dom.clearNode(this.responseWrapper);
		if (this.viewModel?.model.response?.result) {
			const result = this.viewModel.model.response.result;
			this.responseWrapper.appendChild(this.markdownRenderer.render(result).element);
		}
	}

	cancelRequest(): void {
		if (this.viewModel?.sessionId) {
			this.aideProbeService.cancelCurrentRequestForSession(this.viewModel.sessionId);
		}
	}

	clear(): void {
		this.viewModel?.dispose();
		this.viewModel = undefined;
		this.requestInProgress.set(false);
		this._breakdownsList.hide();
		this.onDidChangeItems();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this.inputPart.layout(height, width);
		this._breakdownsList.layout(width);
	}

	override dispose(): void {
		super.dispose();
	}
}