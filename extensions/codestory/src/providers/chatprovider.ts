/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';

import logger from '../logger';
import { CSChatState } from '../chatState/state';
import { getSelectedCodeContextForExplain } from '../utilities/getSelectionContext';
import { logChatPrompt, logSearchPrompt } from '../posthog/logChatPrompt';
import { reportFromStreamToSearchProgress } from '../chatState/convertStreamToMessage';
import { CodeGraph } from '../codeGraph/graph';
import { debuggingFlow } from '../llm/recipe/debugging';
import { ToolingEventCollection } from '../timeline/events/collection';
import { ActiveFilesTracker } from '../activeChanges/activeFilesTracker';
import { UserMessageType, deterministicClassifier } from '../chatState/promptClassifier';
import { CodeSymbolsLanguageCollection } from '../languages/codeSymbolsLanguageCollection';
import { RepoRef, SideCarClient } from '../sidecar/client';
import { ProjectContext } from '../utilities/workspaceContext';

class CSChatParticipant implements vscode.CSChatSessionParticipantInformation {
	name: string;
	icon?: vscode.Uri | undefined;

	constructor(name: string, icon?: vscode.Uri | undefined) {
		this.name = name;
		this.icon = icon;
	}

	toString(): string {
		return `CSChatParticipant { name: "${this.name}", icon: "${this.icon?.toString()}" }`;
	}
}

class CSChatSession implements vscode.CSChatSession {
	requester: CSChatParticipant;
	responder: CSChatParticipant;
	inputPlaceholder?: string | undefined;

	constructor(
		requester: CSChatParticipant,
		responder: CSChatParticipant,
		agentCustomInstruction: string | null,
		inputPlaceholder?: string | undefined,
	) {
		this.requester = requester;
		this.responder = responder;
		this.inputPlaceholder = inputPlaceholder;
	}

	toString(): string {
		return `CSChatSession { requester: ${this.requester.toString()}, responder: ${this.responder.toString()}, inputPlaceholder: "${this.inputPlaceholder}" }`;
	}
}

class CSChatReplyFollowup implements vscode.CSChatSessionReplyFollowup {
	message: string;
	tooltip?: string | undefined;
	title?: string | undefined;
	metadata?: any;

	constructor(message: string, tooltip?: string | undefined, title?: string | undefined, metadata?: any) {
		this.message = message;
		this.tooltip = tooltip;
		this.title = title;
		this.metadata = metadata;
	}

	toString(): string {
		return `CSChatReplyFollowup { message: "${this.message}", tooltip: "${this.tooltip}", title: "${this.title}", metadata: ${JSON.stringify(this.metadata, null, 2)} }`;
	}
}

export class CSChatRequest implements vscode.CSChatAgentRequest {
	threadId: string;
	prompt: string;
	variables: Record<string, vscode.CSChatVariableValue[]>;
	slashCommand?: vscode.ChatAgentSlashCommand;

	constructor(threadId: string, prompt: string, variables: Record<string, vscode.CSChatVariableValue[]> = {}, slashCommand?: vscode.ChatAgentSlashCommand) {
		this.threadId = threadId;
		this.prompt = prompt;
		this.variables = variables;
		this.slashCommand = slashCommand;
	}

	toString(): string {
		return `CSChatRequest { threadId: "${this.threadId}", prompt: "${this.prompt}", variables: ${JSON.stringify(this.variables, null, 2)}, slashCommand: ${this.slashCommand?.toString()} }`;
	}
}

class CSChatResponseErrorDetails implements vscode.ChatAgentErrorDetails {
	message: string;
	responseIsIncomplete?: boolean | undefined;
	responseIsFiltered?: boolean | undefined;

	constructor(message: string, responseIsIncomplete?: boolean | undefined, responseIsFiltered?: boolean | undefined) {
		this.message = message;
		this.responseIsIncomplete = responseIsIncomplete;
		this.responseIsFiltered = responseIsFiltered;
	}

	toString(): string {
		return `CSChatResponseErrorDetails { message: "${this.message}", responseIsIncomplete: "${this.responseIsIncomplete}", responseIsFiltered: "${this.responseIsFiltered}" }`;
	}
}

export class CSChatProgressContent implements vscode.ChatAgentContent {
	content: string;

	constructor(content: string) {
		this.content = content;
	}

	toString(): string {
		return `CSChatProgressContent { content: "${this.content}" }`;
	}
}

export class CSChatProgressUsedContext implements vscode.ChatAgentUsedContext {
	documents: vscode.ChatAgentDocumentContext[];

	constructor(documents: vscode.ChatAgentDocumentContext[]) {
		this.documents = documents;
	}

	toString(): string {
		return `CSChatProgressUsedContext { documents: ${JSON.stringify(this.documents, null, 2)} }`;
	}
}

export class CSChatContentReference implements vscode.ChatAgentContentReference {
	reference: vscode.Uri | vscode.Location;

	constructor(reference: vscode.Uri | vscode.Location) {
		this.reference = reference;
	}

	toString(): string {
		return `CSChatContentReference { reference: "${this.reference}" }`;
	}
}

export class CSChatInlineContentReference implements vscode.ChatAgentInlineContentReference {
	inlineReference: vscode.Uri | vscode.Location;
	title?: string;

	constructor(inlineReference: vscode.Uri | vscode.Location) {
		this.inlineReference = inlineReference;
	}

	toString(): string {
		return `CSChatInlineContentReference { inlineReference: "${this.inlineReference}", title: "${this.title}" }`;
	}
}

export class CSChatFileTreeData implements vscode.ChatAgentFileTreeData {
	label: string;
	uri: vscode.Uri;
	children?: CSChatFileTreeData[] | undefined;

	constructor(label: string, uri: vscode.Uri, children?: CSChatFileTreeData[] | undefined) {
		this.label = label;
		this.uri = uri;
		this.children = children;
	}

	toString(): string {
		return `CSChatFileTreeData { label: "${this.label}", uri: "${this.uri}", children: ${JSON.stringify(this.children, null, 2)} }`;
	}
}

export class CSChatProgressFileTree implements vscode.ChatAgentFileTree {
	treeData: CSChatFileTreeData;

	constructor(treeData: CSChatFileTreeData) {
		this.treeData = treeData;
	}

	toString(): string {
		return `CSChatProgressFileTree { treeData: "${this.treeData}" }`;
	}
}

export class CSChatProgressTask implements vscode.ChatAgentTask {
	placeholder: string;
	resolvedContent: Thenable<CSChatProgressContent | CSChatProgressFileTree>;

	constructor(placeholder: string, resolvedContent: Thenable<CSChatProgressContent | CSChatProgressFileTree>) {
		this.placeholder = placeholder;
		this.resolvedContent = resolvedContent;
	}

	toString(): string {
		return `CSChatProgressTask { placeholder: "${this.placeholder}", resolvedContent: "${this.resolvedContent}" }`;
	}
}

export type CSChatProgress = CSChatProgressContent | CSChatProgressTask | CSChatProgressFileTree | CSChatProgressUsedContext | CSChatContentReference | CSChatInlineContentReference;

class CSChatResponseForProgress implements vscode.ChatAgentResult2 {
	errorDetails?: CSChatResponseErrorDetails | undefined;

	constructor(errorDetails?: CSChatResponseErrorDetails | undefined) {
		this.errorDetails = errorDetails;
	}

	toString(): string {
		return `CSChatResponseForProgress { errorDetails: ${this.errorDetails?.toString()} }`;
	}
}

export class CSChatCancellationToken implements vscode.CancellationToken {
	isCancellationRequested: boolean;
	onCancellationRequested: vscode.Event<any>;

	constructor(isCancellationRequested: boolean, onCancellationRequested: vscode.Event<any>) {
		this.isCancellationRequested = isCancellationRequested;
		this.onCancellationRequested = onCancellationRequested;
	}

	toString(): string {
		return `CSChatCancellationToken { isCancellationRequested: "${this.isCancellationRequested}", onCancellationRequested: "${this.onCancellationRequested}" }`;
	}
}

export class CSChatSessionProvider implements vscode.CSChatSessionProvider<CSChatSession> {
	provideWelcomeMessage?(token: CSChatCancellationToken): vscode.ProviderResult<vscode.CSChatWelcomeMessageContent[]> {
		logger.info('provideWelcomeMessage', token);
		return [
			'Hi, I\'m **Aide**, your personal coding assistant! I can find, understand, explain, debug or write code for you. Here are a few things you can ask me:',
			[
				new CSChatReplyFollowup('Explain the active file in the editor'),
				new CSChatReplyFollowup('Add documentation to the selected code'),
				new CSChatReplyFollowup('How can I clean up this code?'),
			]
		];
	}

	prepareSession(token: CSChatCancellationToken): vscode.ProviderResult<CSChatSession> {
		logger.info('prepareSession', token);
		const userUri = vscode.Uri.joinPath(
			vscode.extensions.getExtension('codestory-ghost.codestoryai')?.extensionUri ?? vscode.Uri.parse(''),
			'assets',
			'aide-user.png'
		);
		const agentUri = vscode.Uri.joinPath(
			vscode.extensions.getExtension('codestory-ghost.codestoryai')?.extensionUri ?? vscode.Uri.parse(''),
			'assets',
			'aide-agent.png'
		);
		return new CSChatSession(
			new CSChatParticipant('You', userUri),
			new CSChatParticipant('Aide', agentUri),
			'',
			'Use / to find specific commands, and @ or # to point me to code to refer while answering your questions',
		);
	}
}

export class CSChatAgentProvider implements vscode.Disposable {
	private chatAgent: vscode.ChatAgent2;

	private _chatSessionState: CSChatState;
	private _codeGraph: CodeGraph;
	private _codeSymbolsLanguageCollection: CodeSymbolsLanguageCollection;
	private _workingDirectory: string;
	private _testSuiteRunCommand: string;
	private _activeFilesTracker: ActiveFilesTracker;
	private _repoName: string;
	private _repoHash: string;
	private _uniqueUserId: string;
	private _agentCustomInformation: string | null;
	private _sideCarClient: SideCarClient;
	private _currentRepoRef: RepoRef;
	private _projectContext: ProjectContext;

	constructor(
		workingDirectory: string,
		codeGraph: CodeGraph,
		repoName: string,
		repoHash: string,
		codeSymbolsLanguageCollection: CodeSymbolsLanguageCollection,
		testSuiteRunCommand: string,
		activeFilesTracker: ActiveFilesTracker,
		uniqueUserId: string,
		agentCustomInstruction: string | null,
		sideCarClient: SideCarClient,
		repoRef: RepoRef,
		projectContext: ProjectContext,
	) {
		this._workingDirectory = workingDirectory;
		this._codeGraph = codeGraph;
		this._repoHash = repoHash;
		this._repoName = repoName;
		this._codeSymbolsLanguageCollection = codeSymbolsLanguageCollection;
		this._testSuiteRunCommand = testSuiteRunCommand;
		this._activeFilesTracker = activeFilesTracker;
		this._uniqueUserId = uniqueUserId;
		this._agentCustomInformation = agentCustomInstruction;
		this._sideCarClient = sideCarClient;
		this._currentRepoRef = repoRef;
		this._projectContext = projectContext;
		this._chatSessionState = new CSChatState(null);

		this.chatAgent = vscode.csChat.createChatAgent('', this.defaultAgent);
		this.chatAgent.isDefault = true;
		this.chatAgent.supportIssueReporting = true;
		this.chatAgent.description = 'Use / to find specific commands, and @ or # to point me to code to refer while answering your questions';
		this.chatAgent.sampleRequest = 'Explain the active file in the editor';
		this.chatAgent.iconPath = vscode.Uri.joinPath(
			vscode.extensions.getExtension('codestory-ghost.codestoryai')?.extensionUri ?? vscode.Uri.parse(''),
			'assets',
			'aide-white.svg'
		);
		this.chatAgent.slashCommandProvider = this.slashCommandProvider;
		this.chatAgent.editsProvider = this.editsProvider;
	}

	defaultAgent: vscode.CSChatAgentExtendedHandler = (request, context, progress, token) => {
		return (async () => {
			let requestType: UserMessageType = 'general';
			const slashCommand = request.slashCommand?.name;
			if (slashCommand) {
				requestType = slashCommand as UserMessageType;
			} else {
				const deterministicRequestType = deterministicClassifier(request.prompt.toString());
				if (deterministicRequestType) {
					requestType = deterministicRequestType;
				}
			}
			logger.info(`[codestory][request_type][provideResponseWithProgress] ${requestType}`);
			if (requestType === 'instruction') {
				const prompt = request.prompt.toString().slice(7).trim();
				if (prompt.length === 0) {
					return new CSChatResponseForProgress(new CSChatResponseErrorDetails('Please provide a prompt for the agent to work on'));
				}

				const toolingEventCollection = new ToolingEventCollection(
					`/tmp/${uuidv4()}`,
					{ progress, cancellationToken: token },
					prompt,
				);

				const uniqueId = uuidv4();
				await debuggingFlow(
					prompt,
					toolingEventCollection,
					this._sideCarClient,
					this._codeSymbolsLanguageCollection,
					this._workingDirectory,
					this._testSuiteRunCommand,
					this._activeFilesTracker,
					uniqueId,
					this._agentCustomInformation,
					this._currentRepoRef,
				);
				return new CSChatResponseForProgress();
			} else if (requestType === 'explain') {
				// Implement the explain feature here
				const explainString = request.prompt.toString().slice('/explain'.length).trim();
				const currentSelection = getSelectedCodeContextForExplain(this._workingDirectory, this._currentRepoRef);
				if (currentSelection === null) {
					progress.report(new CSChatProgressContent('Selecting code on the editor can help us explain it better'));
					return new CSChatResponseForProgress();
				} else {
					const explainResponse = await this._sideCarClient.explainQuery(explainString, this._currentRepoRef, currentSelection, request.threadId);
					await reportFromStreamToSearchProgress(explainResponse, progress, token, this._currentRepoRef, this._workingDirectory);
					return new CSChatResponseForProgress();
				}
			} else if (requestType === 'search') {
				logSearchPrompt(
					request.prompt.toString(),
					this._repoName,
					this._repoHash,
					this._uniqueUserId,
				);
				const searchString = request.prompt.toString().slice('/search'.length).trim();
				const searchResponse = await this._sideCarClient.searchQuery(searchString, this._currentRepoRef, request.threadId);
				await reportFromStreamToSearchProgress(searchResponse, progress, token, this._currentRepoRef, this._workingDirectory);
				// We get back here a bunch of responses which we have to pass properly to the agent
				return new CSChatResponseForProgress();
			} else {
				this._chatSessionState.cleanupChatHistory();
				this._chatSessionState.addUserMessage(request.prompt.toString());
				const query = request.prompt.toString().trim();
				logChatPrompt(
					request.prompt.toString(),
					this._repoName,
					this._repoHash,
					this._uniqueUserId,
				);
				const projectLabels = this._projectContext.labels;
				const followupResponse = await this._sideCarClient.followupQuestion(query, this._currentRepoRef, request.threadId, request.variables, projectLabels);
				await reportFromStreamToSearchProgress(followupResponse, progress, token, this._currentRepoRef, this._workingDirectory);
				return new CSChatResponseForProgress();
			}
		})();
	};

	slashCommandProvider: vscode.ChatAgentSlashCommandProvider = {
		provideSlashCommands: (token: vscode.CancellationToken): vscode.ProviderResult<vscode.ChatAgentSlashCommand[]> => {
			return [
				{
					name: 'explain',
					description: 'Describe or refer to code you\'d like to understand',
				},
				{
					name: 'search',
					description: 'Describe a workflow to find',
				},
			];
		}
	};

	editsProvider: vscode.CSChatEditProvider = {
		provideEdits: async (request, token) => {
			logger.info('provideEditsWithProgress', request, token);
			// Notes to @theskcd:
			// 1. This API currently just applies the edits without any decoration.
			// 2. The current API does not support streaming edits so everything gets applied at once.
			//
			// WIP items on editor side, in order of priority:
			// 1. When edits are made, add a decoration to the changes to highlight agent changes.
			// 2. Displaying the list of edits performed in the chat widget as links (something like the references box).
			// 3. Add options above the inline decorations and in the chat widget to accept/reject the changes.
			// 4. (IF you will be getting edits incrementally from sidecar) Support a progress object so you can
			// push/stream edits one at a time.
			// 5. Add an option to export all codeblocks within a response, rather than one at a time. The API already
			// accepts a list so your implementation need not change.
			//
			// The code below uses the open file & a test file for testing purposes.
			// You can pass in any file uri(s) and it should apply correctly.
			const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
			// Test with a hard-coded file /Users/nareshr/github/upi-deeplinks-python-sdk/setu/body.py
			// const testFileUri = vscode.Uri.file('/Users/nareshr/github/upi-deeplinks-python-sdk/setu/body.py');
			const workspaceEdits = new vscode.WorkspaceEdit();

			const codeblocks = request.context;
			if (activeEditorUri && codeblocks.length > 0) {
				codeblocks.forEach((codeblock) => {
					const newWorkspaceEdit = new vscode.WorkspaceEdit();
					newWorkspaceEdit.insert(
						activeEditorUri,
						new vscode.Position(0, 0),
						codeblock.code
					);
					// workspaceEdits.insert(
					// 	testFileUri,
					// 	new vscode.Position(0, 0),
					// 	codeblock.code
					// );
				});
			}
			return workspaceEdits;
		}
	};

	dispose() {
		console.log('Dispose CSChatAgentProvider');
	}
}