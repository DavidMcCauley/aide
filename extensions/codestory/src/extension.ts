/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commands, ExtensionContext, interactive, window, workspace, languages, modelSelection, env, csevents } from 'vscode';
import * as os from 'os';
import * as http from 'http';

import { loadOrSaveToStorage } from './storage/types';
import logger from './logger';
import postHogClient from './posthog/client';
import { getGitCurrentHash, getGitRepoName } from './git/helper';
import { activateExtensions, getExtensionsInDirectory } from './utilities/activateLSP';
import { CodeSymbolInformationEmbeddings } from './utilities/types';
import { getUniqueId, getUserId, shouldUseExactMatching } from './utilities/uniqueId';
import { readCustomSystemInstruction } from './utilities/systemInstruction';
import { RepoRef, RepoRefBackend, SideCarClient } from './sidecar/client';
import { startSidecarBinary } from './utilities/setupSidecarBinary';
import { CSInteractiveEditorSessionProvider } from './completions/providers/editorSessionProvider';
import { ProjectContext } from './utilities/workspaceContext';
import { CSChatAgentProvider } from './completions/providers/chatprovider';
import { reportIndexingPercentage } from './utilities/reportIndexingUpdate';
import { aideCommands } from './inlineCompletion/commands';
import { startupStatusBar } from './inlineCompletion/statusBar';
import { createInlineCompletionItemProvider } from './completions/create-inline-completion-item-provider';
import { getRelevantFiles, shouldTrackFile } from './utilities/openTabs';
import { checkReadonlyFSMode } from './utilities/readonlyFS';
import { handleRequest } from './server/requestHandler';
import { AddressInfo } from 'net';
import { getSymbolNavigationActionTypeLabel } from './utilities/stringifyEvent';
import { AideQuickFix } from './quickActions/fix';
import { copySettings } from './utilities/copySettings';


export let SIDECAR_CLIENT: SideCarClient | null = null;



export async function activate(context: ExtensionContext) {
	// Project root here
	const uniqueUserId = getUniqueId();
	const userId = getUserId();
	console.log('User id:' + userId);
	logger.info(`[CodeStory]: ${uniqueUserId} Activating extension with storage: ${context.globalStorageUri}`);
	postHogClient?.capture({
		distinctId: getUniqueId(),
		event: 'extension_activated',
		properties: {
			platform: os.platform(),
		},
	});
	const appDataPath = process.env.APPDATA;
	const userProfilePath = process.env.USERPROFILE;
	console.log('appDataPath', appDataPath);
	console.log('userProfilePath', userProfilePath);
	const registerPreCopyCommand = commands.registerCommand(
		'webview.preCopySettings',
		async () => {
			await copySettings(env.appRoot, logger);
		}
	);
	context.subscriptions.push(registerPreCopyCommand);
	let rootPath = workspace.rootPath;
	if (!rootPath) {
		rootPath = '';
	}

	// Create the copy settings from vscode command for the extension
	const registerCopySettingsCommand = commands.registerCommand(
		'webview.copySettings',
		async () => {
			await copySettings(rootPath ?? '', logger);
		}
	);
	context.subscriptions.push(registerCopySettingsCommand);
	const readonlyFS = checkReadonlyFSMode();
	if (readonlyFS) {
		window.showErrorMessage('Move Aide to the Applications folder using Finder. More instructions here: [link](https://docs.codestory.ai/troubleshooting#macos-readonlyfs-warning)');
		return;
	}
	const agentSystemInstruction = readCustomSystemInstruction();
	if (agentSystemInstruction === null) {
		console.log(
			'Aide can help you better if you give it custom instructions by going to your settings and setting it in aide.systemInstruction (search for this string in User Settings) and reload vscode for this to take effect by doing Cmd+Shift+P: Developer: Reload Window'
		);
	}
	// Activate the LSP extensions which are needed for things to work
	await activateExtensions(context, getExtensionsInDirectory(rootPath));

	// Now we get all the required information and log it
	const repoName = await getGitRepoName(
		rootPath,
	);
	const repoHash = await getGitCurrentHash(
		rootPath,
	);

	// We also get some context about the workspace we are in and what we are
	// upto
	const projectContext = new ProjectContext();
	await projectContext.collectContext();

	postHogClient?.capture({
		distinctId: await getUniqueId(),
		event: 'activated_lsp',
		properties: {
			repoName,
			repoHash,
		}
	});


	csevents.registerCSEventHandler({
		handleSymbolNavigation(event) {
			const currentWindow = window.activeTextEditor?.document.uri.fsPath;
			postHogClient?.capture({
				distinctId: getUniqueId(),
				event: 'symbol_navigation',
				properties: {
					action: getSymbolNavigationActionTypeLabel(event.action),
					file_path: event.uri.fsPath,
					current_window: currentWindow,
				},
			});
			console.log('Received symbol navigation event!');
			console.log(event);
		},
	});

	// Get model selection configuration
	const modelConfiguration = await modelSelection.getConfiguration();
	const execPath = process.execPath;
	console.log('Exec path:' + execPath);
	console.log('Model configuration:' + JSON.stringify(modelConfiguration));
	// Setup the sidecar client here
	const sidecarUrl = await startSidecarBinary(context.globalStorageUri.fsPath, env.appRoot);
	// allow-any-unicode-next-line
	// window.showInformationMessage(`Sidecar binary 🦀 started at ${sidecarUrl}`);
	const sidecarClient = new SideCarClient(sidecarUrl, modelConfiguration);
	SIDECAR_CLIENT = sidecarClient;

	// Server for the sidecar to talk to the editor
	const server = http.createServer(handleRequest);
	let port = 42423; // Default chooses 42423, but if its not available then we
	// can still grab it by listenting to port 0
	server.listen(port, () => {
		console.log(`Server for talking to sidecar is running at http://localhost:${port}/`);
	})
		.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE') {
				console.error(`Port ${port} is already in use, trying another port...`);
				server.listen(0, () => {
					const serverAddress = server.address();
					if (serverAddress) {
						const newAddress: AddressInfo = serverAddress as AddressInfo;
						port = newAddress.port;
					}
					console.log(serverAddress);
					console.log(`Server for talking to sidecar is running at http://localhost:${server.address()}/`);
				}); // Use 0 to let the OS pick an available port
			} else {
				console.error(`Failed to start server: ${err.message}`);
			}
		});

	// Register a disposable to stop the server when the extension is deactivated
	context.subscriptions.push({
		dispose: () => {
			if (server) {
				server.close();
			}
		},
	});

	// we want to send the open tabs here to the sidecar
	const openTextDocuments = await getRelevantFiles();
	openTextDocuments.forEach((openTextDocument) => {
		// not awaiting here so we can keep loading the extension in the background
		if (shouldTrackFile(openTextDocument.uri)) {
			sidecarClient.documentOpen(openTextDocument.uri.fsPath, openTextDocument.contents, openTextDocument.language);
		}
	});
	// Setup the current repo representation here
	const currentRepo = new RepoRef(
		// We assume the root-path is the one we are interested in
		rootPath,
		RepoRefBackend.local,
	);
	// setup the callback for the model configuration
	modelSelection.onDidChangeConfiguration((config) => {
		sidecarClient.updateModelConfiguration(config);
		console.log('Model configuration updated:' + JSON.stringify(config));
	});
	await sidecarClient.indexRepositoryIfNotInvoked(currentRepo);
	// Show the indexing percentage on startup
	await reportIndexingPercentage(sidecarClient, currentRepo);

	// register the inline code completion provider
	await createInlineCompletionItemProvider(
		{
			triggerNotice: notice => {
				console.log(notice);
			},
			sidecarClient,
		}
	);
	// register the commands here for inline completion
	aideCommands();
	// set the status bar as well
	startupStatusBar();

	// Get the storage object here
	const codeStoryStorage = await loadOrSaveToStorage(context.globalStorageUri.fsPath, rootPath);
	logger.info(codeStoryStorage);
	logger.info(rootPath);


	// Register the semantic search command here
	commands.registerCommand('codestory.semanticSearch', async (prompt: string): Promise<CodeSymbolInformationEmbeddings[]> => {
		logger.info('[semanticSearch][extension] We are executing semantic search :' + prompt);
		postHogClient?.capture({
			distinctId: await getUniqueId(),
			event: 'search',
			properties: {
				prompt,
				repoName,
				repoHash,
			},
		});
		// We should be using the searchIndexCollection instead here, but for now
		// embedding search is fine
		// Here we will ping the semantic client instead so we can get the results
		const results = await sidecarClient.getSemanticSearchResult(
			prompt,
			currentRepo,
		);
		return results;
	});

	// Register the quick action providers
	const aideQuickFix = new AideQuickFix();
	languages.registerCodeActionsProvider('*', aideQuickFix);

	// Register chat provider
	const interactiveEditorSessionProvider = new CSInteractiveEditorSessionProvider(
		sidecarClient,
		currentRepo,
		rootPath ?? '',
		shouldUseExactMatching(),
	);
	const interactiveEditorSession = interactive.registerInteractiveEditorSessionProvider(
		interactiveEditorSessionProvider,
	);
	context.subscriptions.push(interactiveEditorSession);

	const chatAgentProvider = new CSChatAgentProvider(
		rootPath, repoName, repoHash,
		uniqueUserId,
		sidecarClient, currentRepo, projectContext,
	);
	context.subscriptions.push(chatAgentProvider);

	// Register feedback commands
	context.subscriptions.push(
		commands.registerCommand('codestory.feedback', async () => {
			// Redirect to Discord server link
			await commands.executeCommand('vscode.open', 'https://discord.gg/FdKXRDGVuz');
		})
	);

	window.onDidChangeActiveTextEditor(async (editor) => {
		if (editor) {
			const activeDocument = editor.document;
			if (activeDocument) {
				const activeDocumentUri = activeDocument.uri;
				if (shouldTrackFile(activeDocumentUri)) {
					console.log('editor.onDidChangeActiveTextEditor', activeDocumentUri.fsPath);
					await sidecarClient.documentOpen(
						activeDocumentUri.fsPath,
						activeDocument.getText(),
						activeDocument.languageId
					);
				}
			}
		}
	});

	// Listen to all the files which are changing, so we can keep our tree sitter cache hot
	workspace.onDidChangeTextDocument(async (event) => {
		const documentUri = event.document.uri;
		// if its a schema type, then skip tracking it
		if (documentUri.scheme === 'vscode') {
			return;
		}
		// TODO(skcd): we want to send the file change event to the sidecar over here
		if (shouldTrackFile(documentUri)) {
			await sidecarClient.documentContentChange(
				documentUri.fsPath,
				event.contentChanges,
				event.document.getText(),
				event.document.languageId,
			);
		}
	});


	// TODO(skcd): I promise to clean this up better, I am trying to see if things still
	// work if I wait here and check the diagnostics and if its working
	// await new Promise(resolve => setTimeout(resolve, 20000));
	// // over here we will execute the code action provider
	// try {
	// 	const textDocumentUri = Uri.file('/Users/skcd/scratch/sidecar/sidecar/src/agentic/symbol/helpers.rs');
	// 	// opens the text document as required
	// 	await workspace.openTextDocument(textDocumentUri);
	// 	const range = new vscode.Range(new Position(3, 24), new Position(3, 25));
	// 	const codeActions: vscode.CodeAction[] = await commands.executeCommand(
	// 		'vscode.executeCodeActionProvider',
	// 		textDocumentUri,
	// 		range,
	// 	);
	// 	console.log('code actions worked');
	// 	// lets see what happens over here
	// 	console.log(codeActions);
	// 	const firstCodeActionCommand = codeActions[1].command;
	// 	const firstCodeArguments = codeActions[1].command?.arguments;
	// 	try {
	// 		if (firstCodeActionCommand !== undefined && firstCodeArguments !== undefined) {
	// 			// console.log(firstCodeAction.command);
	// 			// console.log(firstCodeAction.arguments);
	// 			console.log(firstCodeArguments[0]);
	// 			const firstArgument = firstCodeArguments[0][0].arguments;
	// 			console.log(firstArgument);
	// 			const result = await commands.executeCommand('rust-analyzer.resolveCodeAction', firstArgument);
	// 			// const result = await commands.executeCommand(firstCodeActionCommand.command, ...firstCodeArguments);
	// 			console.log('sub results from result');
	// 			console.log(result);
	// 		} else {
	// 			console.log('missing command');
	// 		}
	// 	} catch (exception) {
	// 		console.log(exception);
	// 	}
	// 	// await commands.executeCommand(codeActions[0].command, ...codeActions[1].arguments);
	// } catch (exception) {
	// 	console.log('code action execution error');
	// 	console.error(exception);
	// }
}
