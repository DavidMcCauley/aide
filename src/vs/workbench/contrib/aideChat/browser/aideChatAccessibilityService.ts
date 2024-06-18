/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { status } from 'vs/base/browser/ui/aria/aria';
import { Disposable, DisposableMap } from 'vs/base/common/lifecycle';
import { AccessibilitySignal, IAccessibilitySignalService } from 'vs/platform/accessibilitySignal/browser/accessibilitySignalService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { AccessibilityProgressSignalScheduler } from 'vs/platform/accessibilitySignal/browser/progressAccessibilitySignalScheduler';
import { IAideChatAccessibilityService } from 'vs/workbench/contrib/aideChat/browser/aideChat';
import { IChatResponseViewModel } from 'vs/workbench/contrib/aideChat/common/aideChatViewModel';
import { renderStringAsPlaintext } from 'vs/base/browser/markdownRenderer';

const CHAT_RESPONSE_PENDING_ALLOWANCE_MS = 4000;
export class ChatAccessibilityService extends Disposable implements IAideChatAccessibilityService {

	declare readonly _serviceBrand: undefined;

	private _pendingSignalMap: DisposableMap<number, AccessibilityProgressSignalScheduler> = this._register(new DisposableMap());

	private _requestId: number = 0;

	constructor(@IAccessibilitySignalService private readonly _accessibilitySignalService: IAccessibilitySignalService, @IInstantiationService private readonly _instantiationService: IInstantiationService) {
		super();
	}
	acceptRequest(): number {
		this._requestId++;
		this._accessibilitySignalService.playSignal(AccessibilitySignal.chatRequestSent, { allowManyInParallel: true });
		this._pendingSignalMap.set(this._requestId, this._instantiationService.createInstance(AccessibilityProgressSignalScheduler, CHAT_RESPONSE_PENDING_ALLOWANCE_MS, undefined));
		return this._requestId;
	}
	acceptResponse(response: IChatResponseViewModel | string | undefined, requestId: number): void {
		this._pendingSignalMap.deleteAndDispose(requestId);
		const isPanelChat = typeof response !== 'string';
		const responseContent = typeof response === 'string' ? response : response?.response.asString();
		this._accessibilitySignalService.playSignal(AccessibilitySignal.chatResponseReceived, { allowManyInParallel: true });
		if (!response || !responseContent) {
			return;
		}
		const errorDetails = isPanelChat && response.errorDetails ? ` ${response.errorDetails.message}` : '';
		status(renderStringAsPlaintext(responseContent) + errorDetails);
	}
}
