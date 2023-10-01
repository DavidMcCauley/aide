/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { arc, chat, commands, ExtensionContext, interactive, TextDocument, window, workspace } from 'vscode';
import { EventEmitter } from 'events';
import winston from 'winston';

import { loadOrSaveToStorage } from './storage/types';
import { getProject } from './utilities/parseTypescript';
import logger from './logger';
import { CodeGraph } from './codeGraph/graph';
import { EmbeddingsSearch } from './searchIndex/embeddingsSearch';
import postHogClient from './posthog/client';
import { CodeStoryViewProvider } from './providers/codeStoryView';
import { healthCheck } from './subscriptions/health';
import { TrackCodeSymbolChanges } from './activeChanges/trackCodeSymbolChanges';
import { FILE_SAVE_TIME_PERIOD, TimeKeeper } from './subscriptions/timekeeper';
import { fileStateFromPreviousCommit } from './activeChanges/fileStateFromPreviousCommit';
import { CodeBlockChangeDescriptionGenerator } from './activeChanges/codeBlockChangeDescriptionGenerator';
import { triggerCodeSymbolChange } from './activeChanges/timeline';
import { gitCommit } from './subscriptions/gitCommit';
import { getFilesTrackedInWorkingDirectory, getGitCurrentHash, getGitRepoName } from './git/helper';
import { debug } from './subscriptions/debug';
import { copySettings } from './utilities/copySettings';
import { readActiveDirectoriesConfiguration, readTestSuiteRunCommand } from './utilities/activeDirectories';
import { activateExtensions, getExtensionsInDirectory } from './utilities/activateLSP';
import { CSChatProvider } from './providers/chatprovider';
import { ActiveFilesTracker } from './activeChanges/activeFilesTracker';
import { GoLangParser } from './languages/goCodeSymbols';
import { CodeSymbolInformationEmbeddings } from './utilities/types';
import { CodeSymbolsLanguageCollection } from './languages/codeSymbolsLanguageCollection';
import { getUniqueId } from './utilities/uniqueId';
import { SearchIndexCollection } from './searchIndex/collection';
import { DocumentSymbolBasedIndex } from './searchIndex/documentSymbolRepresenatation';
import { TreeSitterChunkingBasedIndex } from './searchIndex/treeSitterParsing';
import { generateEmbeddingFromSentenceTransformers, getEmbeddingModel } from './llm/embeddings/sentenceTransformers';
import { LanguageParser } from './languages/languageCodeSymbols';
import { readCustomSystemInstruction } from './utilities/systemInstruction';
import { CSAgentMetadata, CSAgentProvider } from './providers/agentProvider';


class ProgressiveTrackSymbols {
	private emitter: EventEmitter;

	constructor() {
		this.emitter = new EventEmitter();
	}

	async onLoadFromLastCommit(
		trackCodeSymbolChanges: TrackCodeSymbolChanges,
		workingDirectory: string,
		logger: winston.Logger,
	) {
		const filesChangedFromLastCommit = await fileStateFromPreviousCommit(
			workingDirectory ?? '',
			logger,
		);

		for (const fileChanged of filesChangedFromLastCommit) {
			await trackCodeSymbolChanges.filesChangedSinceLastCommit(
				fileChanged.filePath,
				fileChanged.fileContent,
				this.emitter,
			);
		}
		trackCodeSymbolChanges.statusUpdated = true;
	}

	on(event: string, listener: (...args: any[]) => void) {
		this.emitter.on(event, listener);
	}
}


export async function activate(context: ExtensionContext) {
	// Project root here
	const uniqueUserId = await getUniqueId();
	logger.info(`[CodeStory]: ${uniqueUserId} Activating extension with storage: ${context.globalStorageUri}`);
	postHogClient.capture({
		distinctId: await getUniqueId(),
		event: 'extension_activated',
	});
	let rootPath = workspace.rootPath;
	if (!rootPath) {
		rootPath = '';
	}
	if (rootPath === '') {
		window.showErrorMessage('Please open a folder in VS Code to use CodeStory');
		return;
	}
	const agentSystemInstruction = readCustomSystemInstruction();
	if (agentSystemInstruction === null) {
		window.showInformationMessage(
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

	postHogClient.capture({
		distinctId: await getUniqueId(),
		event: 'activated_lsp',
		properties: {
			repoName,
			repoHash,
		}
	});

	// We also load up the sentence transformer here before doing heavy operations
	// with it
	const embeddings = await generateEmbeddingFromSentenceTransformers('something', 'test');
	console.log('[embeddings]', embeddings);


	// Setup python language parser
	const pythonLanguageParser = new LanguageParser(
		rootPath ?? '',
		'python',
		['py'],
	);
	// Setup golang parser here
	const goLangParser = new GoLangParser(rootPath ?? '');
	// Ts-morph project management
	const activeDirectories = readActiveDirectoriesConfiguration(rootPath);
	const extensionSet = getExtensionsInDirectory(rootPath);
	const projectManagement = await getProject(activeDirectories, extensionSet, rootPath);

	// Now setup the indexer collection
	const codeSymbolsLanguageCollection = new CodeSymbolsLanguageCollection();
	codeSymbolsLanguageCollection.addCodeIndexerForType('typescript', projectManagement);
	codeSymbolsLanguageCollection.addCodeIndexerForType('python', pythonLanguageParser);
	codeSymbolsLanguageCollection.addCodeIndexerForType('go', goLangParser);

	// Get the storage object here
	const codeStoryStorage = await loadOrSaveToStorage(context.globalStorageUri.fsPath, rootPath);
	logger.info(codeStoryStorage);
	logger.info(rootPath);
	// Active files tracker
	const activeFilesTracker = new ActiveFilesTracker();
	// Get the test-suite command
	const testSuiteRunCommand = readTestSuiteRunCommand();

	// Setup the search index collection
	const searchIndexCollection = new SearchIndexCollection(
		rootPath ?? '',
	);
	// TODO(codestory): disable embedding search for now
	const embeddingsIndex = new EmbeddingsSearch(
		activeFilesTracker,
		codeSymbolsLanguageCollection,
		context.globalStorageUri.fsPath,
		repoName,
	);
	searchIndexCollection.addIndexer(embeddingsIndex);
	const documentSymbolIndex = new DocumentSymbolBasedIndex(
		repoName,
		context.globalStorageUri.fsPath,
	);
	searchIndexCollection.addIndexer(documentSymbolIndex);
	const treeSitterParsing = new TreeSitterChunkingBasedIndex(
		repoName,
		context.globalStorageUri.fsPath,
	);
	searchIndexCollection.addIndexer(treeSitterParsing);
	const filesToTrack = await getFilesTrackedInWorkingDirectory(rootPath ?? '');
	// This is a super fast step which just starts the indexing step
	await searchIndexCollection.startupIndexers(filesToTrack);


	// Register the semantic search command here
	commands.registerCommand('codestory.semanticSearch', async (prompt: string): Promise<CodeSymbolInformationEmbeddings[]> => {
		logger.info('[semanticSearch][extension] We are executing semantic search :' + prompt);
		postHogClient.capture({
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
		const results = await embeddingsIndex.generateNodesForUserQuery(prompt);
		return results;
	});

	const codeGraph = new CodeGraph(
		activeFilesTracker,
		codeSymbolsLanguageCollection,
		context.globalStorageUri.fsPath,
		repoName,
		rootPath ?? '',
	);
	codeGraph.loadGraph(filesToTrack);

	// Register chat provider
	const chatProvider = new CSChatProvider(
		rootPath, codeGraph, repoName, repoHash,
		searchIndexCollection, codeSymbolsLanguageCollection,
		testSuiteRunCommand, activeFilesTracker, uniqueUserId,
		agentSystemInstruction,
	);
	const interactiveSession = interactive.registerInteractiveSessionProvider(
		'cs-chat', chatProvider
	);
	context.subscriptions.push(interactiveSession);
	await commands.executeCommand('workbench.action.chat.clear');
	await commands.executeCommand('workbench.action.toggleHoverChat.cs-chat');

	const arcProvider = arc.registerArcProvider('cs-arc', chatProvider);
	context.subscriptions.push(arcProvider);

	const csAgentProvider = new CSAgentProvider();
	const csAgent = chat.registerAgent(
		'cs-agent', csAgentProvider.provideAgentResponse.bind(csAgentProvider), new CSAgentMetadata('CodeStory Agent', 'CodeStory Agent', undefined, [])
	);
	context.subscriptions.push(csAgent);

	context.subscriptions.push(
		debug(
			// TODO(codestory): Fix this properly later on
			chatProvider,
			searchIndexCollection,
			codeSymbolsLanguageCollection,
			repoName,
			repoHash,
			rootPath ?? '',
			testSuiteRunCommand,
			activeFilesTracker,
			uniqueUserId,
			agentSystemInstruction,
		)
	);

	// Create the copy settings from vscode command for the extension
	const registerCopySettingsCommand = commands.registerCommand(
		'webview.copySettings',
		async () => {
			await copySettings(rootPath ?? '', logger);
		}
	);

	// Register the codestory view provider
	// Create a new CodeStoryViewProvider instance and register it with the extension's context
	const provider = new CodeStoryViewProvider(context.extensionUri, new Date());
	context.subscriptions.push(
		window.registerWebviewViewProvider(CodeStoryViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// Now we want to register the HC
	context.subscriptions.push(
		healthCheck(
			context,
			provider,
			repoName,
			repoHash,
			uniqueUserId,
		)
	);
	commands.executeCommand('codestory.healthCheck');

	const trackCodeSymbolChanges = new TrackCodeSymbolChanges(
		codeSymbolsLanguageCollection,
		rootPath ?? '',
		logger
	);
	logger.info('[check 6]We are over here');
	const timeKeeperFileSaved = new TimeKeeper(FILE_SAVE_TIME_PERIOD);
	logger.info('[check 7]We are over here');

	// Keeps track of the symbols which are changing and creates a graph of
	// those changes
	const progressiveTrackSymbolsOnLoad = new ProgressiveTrackSymbols();
	progressiveTrackSymbolsOnLoad.on('fileChanged', (fileChangedEvent) => {
		trackCodeSymbolChanges.setFileOpenedCodeSymbolTracked(
			fileChangedEvent.filePath,
			fileChangedEvent.codeSymbols
		);
	});
	progressiveTrackSymbolsOnLoad.onLoadFromLastCommit(
		trackCodeSymbolChanges,
		rootPath ?? '',
		logger,
	);
	logger.info('[check 9]We are over here');

	// Also track the documents when they were last opened
	// context.subscriptions.push(
	workspace.onDidOpenTextDocument(async (doc) => {
		const uri = doc.uri;
		await trackCodeSymbolChanges.fileOpened(uri, logger);
	});

	logger.info('[check 10]We are over here');

	// Now we parse the documents on save as well
	context.subscriptions.push(
		workspace.onDidSaveTextDocument(async (doc) => {
			const uri = doc.uri;
			const fsPath = doc.uri.fsPath;
			await trackCodeSymbolChanges.fileSaved(uri, logger);
			await searchIndexCollection.indexFile(fsPath);
			await triggerCodeSymbolChange(
				provider,
				trackCodeSymbolChanges,
				timeKeeperFileSaved,
				fsPath,
				new CodeBlockChangeDescriptionGenerator(logger),
				logger
			);
		})
	);

	// Add git commit to the subscriptions here
	// Git commit
	context.subscriptions.push(gitCommit(logger, repoName, repoHash, uniqueUserId));
	context.subscriptions.push(registerCopySettingsCommand);

	// Listen for document opened events
	workspace.onDidOpenTextDocument((document: TextDocument) => {
		activeFilesTracker.openTextDocument(document);
	});

	// Listen for document closed events
	workspace.onDidCloseTextDocument((document: TextDocument) => {
		activeFilesTracker.onCloseTextDocument(document);
	});

	// Listen for active editor change events (user navigating between files)
	window.onDidChangeActiveTextEditor((editor) => {
		activeFilesTracker.onDidChangeActiveTextEditor(editor);
	});
}
