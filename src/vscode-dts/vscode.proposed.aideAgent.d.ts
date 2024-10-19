/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {
	export enum AideAgentMode {
		Edit = 1,
		Plan = 2,
		Chat = 3
	}

	export enum AideAgentScope {
		Selection = 1,
		PinnedContext = 2,
		Codebase = 3
	}


	export enum AideAgentEditsState {
		Loading = 'loading',
		InReview = 'inReview',
		MarkedComplete = 'markedComplete',
		Cancelled = 'cancelled',
	}

	export type AideAgentEditsStateType = `${AideAgentEditsState}`;

	export interface AideAgentFileReference extends ChatPromptReference {
		readonly id: 'vscode.file';
		readonly value: {
			uri: Uri;
			range: Range;
		};
	}

	export interface AideAgentCodeReference extends ChatPromptReference {
		readonly id: 'vscode.code';
		readonly value: {
			uri: Uri;
			range: Range;
		};
	}

	// This is a cool looking type, but TypeScript currently doesn't enforce it. But it helps understand
	// the intent for us to use it correctly.
	export type AideAgentPromptReference =
		| AideAgentFileReference
		| AideAgentCodeReference
		| (Omit<ChatPromptReference, 'id'> & { id: Exclude<string, 'vscode.file'> });

	export interface AideAgentRequest extends ChatRequest {
		// is this the exchange id, if so it should explicity be named that instead of id :|
		readonly id: string;
		readonly mode: AideAgentMode;
		readonly scope: AideAgentScope;
		readonly references: readonly AideAgentPromptReference[];
	}

	export class ChatResponseCodeEditPart {
		edits: WorkspaceEdit;
		constructor(edits: WorkspaceEdit);
	}

	export type AideAgentResponsePart = ExtendedChatResponsePart | ChatResponseCodeEditPart;

	export interface AideChatStep {
		/**
		 * The index of the step in the plan
		 */
		readonly index: number;
		/**
		 * Wether it's the last step in the plan
		 */
		readonly isLast: boolean;
		/**
		 * The title of the step in the plan
		 */
		readonly title: string;
		/**
		 * The description of the step
		 */
		readonly description: string | MarkdownString;
		/*
		 * The session id of the plan
		 */
		readonly sessionId: string;
	}

	export interface AideAgentEditsInfo {
		/*
		 * State of the edits
		 */
		readonly state: AideAgentEditsStateType;
		/*
		 * Wether the edits are stale
		 */
		readonly isStale: boolean;
		/*
		 * Files affected by the change
		 */
		readonly files: Uri[];
		/*
		 * Description of the edits
		 */
		readonly description?: string | MarkdownString;
		/*
		 * The session id of the plan
		 */
		readonly sessionId: string;
		/*
		 * The session id of the plan
		 */
		readonly exchangeId: string;
	}

	export interface AideAgentResponseStream extends ChatResponseStream {
		editsInfo(edits: AideAgentEditsInfo): void;
		codeEdit(edits: WorkspaceEdit): void;
		step(step: AideChatStep): void;
		push(part: AideAgentResponsePart): void;
		close(): void;
	}

	export interface AideAgentEventSenderResponse {
		stream: AideAgentResponseStream;
		exchangeId: string;
		token: CancellationToken;
	}

	export type AideSessionHandler = (id: string) => void;
	export type AideSessionEventHandler = (event: AideAgentRequest, token: CancellationToken) => ProviderResult<ChatResult | void>;
	export type AideSessionEventSender = (sessionId: string) => Thenable<AideAgentEventSenderResponse | undefined>;

	export interface AideSessionParticipant {
		newSession: AideSessionHandler;
		handleEvent: AideSessionEventHandler;
	}

	interface AideSessionAgent extends Omit<ChatParticipant, 'requestHandler'> {
		requestHandler: AideSessionEventHandler;
		readonly initResponse: AideSessionEventSender;
	}

	export namespace aideAgent {
		export function createChatParticipant(id: string, resolver: AideSessionParticipant): AideSessionAgent;
		export function registerChatParticipantDetectionProvider(participantDetectionProvider: ChatParticipantDetectionProvider): Disposable;
		export function registerChatVariableResolver(id: string, name: string, userDescription: string, modelDescription: string | undefined, isSlow: boolean | undefined, resolver: ChatVariableResolver, fullName?: string, icon?: ThemeIcon): Disposable;
		export function registerMappedEditsProvider2(provider: MappedEditsProvider2): Disposable;
	}
}
