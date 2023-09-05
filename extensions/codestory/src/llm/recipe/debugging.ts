/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// We are powering the debugging route here.
import {
	OpenAI,
} from 'openai';
import * as vscode from 'vscode';
import posthogClient from '../../posthog/client';
import { fileFunctionsToParsePrompt, generateFileFunctionsResponseParser, generatePlanAndQueriesPrompt, generatePlanAndQueriesResponseParser } from './prompts';
import { ToolingEventCollection } from '../../timeline/events/collection';
import { CodeGraph, generateCodeGraph } from '../../codeGraph/graph';
import { EmbeddingsSearch } from '../../codeGraph/embeddingsSearch';
import { executeTestHarness, formatFileInformationListForPrompt, generateCodeSymbolsForQueries, generateFileInformationSummary, generateModificationInputForCodeSymbol, generateModifiedFileContentAfterDiff, generateTestScriptForChange, getFilePathForCodeNode, readFileContents, shouldExecuteTestHarness, stripPrefix, writeFileContents } from './helpers';
import { TSMorphProjectManagement, getProject, getTsConfigFiles } from '../../utilities/parseTypescript';
import { PythonServer } from '../../utilities/pythonServerClient';
import { ActiveFilesTracker } from '../../activeChanges/activeFilesTracker';
import { getOpenAIApiKey } from '../../utilities/getOpenAIKey';
import { GoLangParser } from '../../languages/goCodeSymbols';
import { Progress } from 'vscode';
import { CSChatCancellationToken, CSChatProgress, CSChatProgressContent, CSChatProgressTask } from '../../providers/chatprovider';

const openai = new OpenAI({
	apiKey: getOpenAIApiKey(),
});
// const openai = new OpenAI({
// 	apiKey: 'EMPTY',
// });
// openai.baseURL = 'http://20.245.250.159:8080/v1'

const systemPrompt = (): string => {
	return 'Your name is CodeStory bot. You are a brilliant and meticulous engineer assigned to write code for the following Github issue. When you write code, the code works on the first try and is formatted perfectly. You have the utmost care for the code that you write, so you do not make mistakes. Take into account the current repository\'s language, frameworks, and dependencies.';
};

export const generateChatCompletion = async (
	messages: OpenAI.Chat.CreateChatCompletionRequestMessage[],
	context: string,
	uniqueId: string,
): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | null> => {
	const completions = await openai.chat.completions.create({
		model: 'gpt-4-32k',
		messages: messages,
		// TODO(codestory): Need to toggle this better
		max_tokens: 8000,
	});
	if (completions.choices.length !== 0) {
		posthogClient.capture({
			distinctId: uniqueId,
			event: `[gpt4]${context}`,
			properties: {
				context: context,
				completion: completions.choices[0].message,
			},
		});
		return completions.choices[0];
	}
	return null;
};

export const debuggingFlow = async (
	prompt: string,
	toolingEventCollection: ToolingEventCollection,
	codeGraph: CodeGraph,
	embeddingsSearch: EmbeddingsSearch,
	tsMorphProjectManagement: TSMorphProjectManagement,
	pythonServer: PythonServer,
	goLangParser: GoLangParser,
	workingDirectory: string,
	testSuiteRunCommand: string,
	activeFilesTracker: ActiveFilesTracker,
	userProvidedContext: vscode.InteractiveUserProvidedContext | undefined,
	uniqueId: string,
): Promise<null> => {
	await toolingEventCollection.addThinkingEvent(prompt, 'I\'m on it!');
	let initialMessages: OpenAI.Chat.CreateChatCompletionRequestMessage[] = [
		{
			content: systemPrompt(),
			role: 'system',
		},
		{
			content: prompt,
			role: 'user',
		},
		{
			content: generatePlanAndQueriesPrompt(),
			role: 'user',
		},
	];
	const response = await generateChatCompletion(
		initialMessages,
		'initial_plan_and_queries',
		uniqueId,
	);
	const planAndQueries = generatePlanAndQueriesResponseParser(response?.message?.content ?? '');

	// Now we swap the memory of the agent
	initialMessages = [
		{
			content: systemPrompt(),
			role: 'system',
		},
		{
			content: prompt,
			role: 'user',
		},
		{
			content: planAndQueries?.additionalInstructions.join('\n') ?? '',
			role: 'user',
		},
	];

	// Adding tooling event for plan
	await toolingEventCollection.addPlanForHelp(
		prompt,
		planAndQueries?.additionalInstructions?.join('\n') ?? ''
	);

	if (userProvidedContext) {
		// Add tooling event for user provided context
		await toolingEventCollection.userProvidedContext(userProvidedContext);
	} else {
		// Adding tooling event for search
		await toolingEventCollection.addSearchEvent(planAndQueries?.queries ?? []);
	}
	// Now we will try and do the search over the symbols
	const relevantCodeSymbols = await generateCodeSymbolsForQueries(
		planAndQueries?.queries ?? [],
		embeddingsSearch,
		activeFilesTracker,
		userProvidedContext,
	);
	// Add the search results here
	await toolingEventCollection.addRelevantSearchResults(
		planAndQueries?.queries ?? [],
		relevantCodeSymbols
	);

	// Now we get all the file information for the symbols
	const fileCodeSymbolInformationList = await generateFileInformationSummary(
		relevantCodeSymbols,
		tsMorphProjectManagement,
		pythonServer,
		goLangParser,
		workingDirectory,
	);
	initialMessages.push(
		{
			content: await formatFileInformationListForPrompt(
				fileCodeSymbolInformationList,
			),
			role: 'user',
		}
	);
	initialMessages.push(
		{
			content: fileFunctionsToParsePrompt(),
			role: 'user',
		}
	);
	const fileFilterInformation = await generateChatCompletion(
		initialMessages,
		'file_filtering',
		uniqueId,
	);
	const codeSymbolModificationInstructions = generateFileFunctionsResponseParser(
		fileFilterInformation?.message?.content ?? '',
	);
	// We want to remove the prompts here which sends over the data about the which
	// files we need to parse to get the result,
	// We should move this state management to its own component soon
	initialMessages.pop();
	initialMessages.pop();

	// Now we start branching out, so we are going to send a event for this
	await toolingEventCollection.branchingStartEvent(
		codeSymbolModificationInstructions.codeSymbolModificationInstructionList.length,
		codeSymbolModificationInstructions.codeSymbolModificationInstructionList,
	);

	// Now we start branching out, so lets do this
	for (let index = 0; index < codeSymbolModificationInstructions.codeSymbolModificationInstructionList.length; index++) {
		const executionEventId = index;

		const filePathForCodeNode = getFilePathForCodeNode(
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
			codeGraph,
		);


		if (!filePathForCodeNode) {
			await toolingEventCollection.executionBranchFinished(
				executionEventId.toString(),
				codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
				'File path not found',
			);
			posthogClient.capture({
				distinctId: uniqueId,
				event: '[error]file_path_not_found',
				properties: {
					codeSymbolName: codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
					initialMessages,
					prompt,
				},
			});
			//TODO(codestory) Send a failure event here
			continue;
		}

		// We also need the previous file content in case of test failures
		const previousFileContent = await readFileContents(filePathForCodeNode);

		// Add tooling event for modification here
		await toolingEventCollection.addInstructionsForModification(
			executionEventId,
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index],
		);

		// Modification logic
		const codeModificationInput = await generateModificationInputForCodeSymbol(
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index],
			[...initialMessages],
			codeGraph,
			uniqueId,
		);
		if (!codeModificationInput) {
			await toolingEventCollection.executionBranchFinished(
				executionEventId.toString(),
				codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
				'Code modification generation failure',
			);
			posthogClient.capture({
				distinctId: uniqueId,
				event: '[error]code_modification_generation_failure',
				properties: {
					codeSymbolName: codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
					initialMessages,
					fileContent: previousFileContent,
					prompt,
				},
			});
			//TODO(codestory): Send a failure event here
			continue;
		}

		// Add to the tooling event tracking
		await toolingEventCollection.addModificationDiffAndThoughts(
			codeModificationInput,
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
			executionEventId.toString(),
		);

		// Now we generate the modified file content from the diff
		const newFileContent = await generateModifiedFileContentAfterDiff(
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index],
			codeModificationInput,
			codeGraph,
			[...initialMessages],
			uniqueId,
		);
		if (!newFileContent) {
			await toolingEventCollection.executionBranchFinished(
				executionEventId.toString(),
				codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
				'New file generation failure',
			);
			// Send a failure event here
			continue;
		}

		// Now we will update the content of the file at this point,
		// this is bad.. but whatever for now as we keep pushing
		writeFileContents(
			filePathForCodeNode,
			newFileContent.newFileContent,
		);

		// Now we send the save to file event
		await toolingEventCollection.saveFileEvent(
			filePathForCodeNode,
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
			executionEventId.toString(),
		);

		if (!shouldExecuteTestHarness(testSuiteRunCommand)) {
			await toolingEventCollection.executionBranchFinished(
				executionEventId.toString(),
				codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
				'Test harness not configured, skipping test execution',
			);
			continue;
		}

		// Now we are at the test plan generation phase
		const testPlan = await generateTestScriptForChange(
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
			codeGraph,
			codeModificationInput,
			[...initialMessages],
			stripPrefix(
				filePathForCodeNode,
				workingDirectory,
			),
			previousFileContent,
			uniqueId,
		);

		if (!testPlan) {
			// Send a failure event here
			await toolingEventCollection.executionBranchFinished(
				executionEventId.toString(),
				codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
				'Test Plan generation failure',
			);
			continue;
		}

		// Now we send the test execution event
		await toolingEventCollection.testExecutionEvent(
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
			filePathForCodeNode,
			testPlan,
			executionEventId.toString(),
		);

		// Now we will execute the test harness and see if we get a positive result
		const testExitCode = await executeTestHarness(
			testPlan,
			[...initialMessages],
			toolingEventCollection,
			executionEventId.toString(),
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
			codeGraph,
			tsMorphProjectManagement,
			pythonServer,
			workingDirectory,
			uniqueId,
		);

		let branchFinishReason = '';

		// Now we need to compare the test exit code to see if its a success of failure
		if (testExitCode !== 0) {
			// TODO(codestory): Add context here why we are reverting the file
			await toolingEventCollection.saveFileEvent(
				filePathForCodeNode,
				codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
				executionEventId.toString(),
			);
			await writeFileContents(
				filePathForCodeNode,
				previousFileContent,
			);
			branchFinishReason = 'Test failure';
		} else {
			branchFinishReason = 'Test success';
		}
		await toolingEventCollection.executionBranchFinished(
			executionEventId.toString(),
			codeSymbolModificationInstructions.codeSymbolModificationInstructionList[index].codeSymbolName,
			branchFinishReason,
		);
	}
	await toolingEventCollection.taskComplete();
	await toolingEventCollection.save();
	return null;
};


// void (async () => {
//     const testingPrompt = `
//     Can you make sure that the embeddings computation does not throw error but returns -1 when the lengths are not equal.
//     `;
//     const workingDirectory = '/Users/skcd/scratch/vscode_plugin/';
//     const storagePath = '/Users/skcd/Library/Application Support/Code/User/globalStorage/undefined_publisher.codestoryai';
//     const codeStoryStorage = await loadOrSaveToStorage(storagePath, workingDirectory);
//     const projectManagement = await getProject(workingDirectory);
//     console.log('Whats the typescript configs we have', projectManagement.directoryToProjectMapping);
//     const codeGraph = generateCodeGraph(projectManagement);
//     // const codeStoryStorage = await loadOrSaveToStorage(context, rootPath);
//     const symbolWithEmbeddings = await indexRepository(
//         codeStoryStorage,
//         projectManagement,
//         storagePath,
//         workingDirectory,
//     );
//     const embeddingsIndex = new EmbeddingsSearch(symbolWithEmbeddings);
//     const toolingEventCollection = new ToolingEventCollection(
//         '/tmp/tooling_event_codestory',
//         codeGraph
//     );
//     const tsMorphProjectManagement = await getProject(workingDirectory);
//     await debuggingFlow(
//         testingPrompt,
//         toolingEventCollection,
//         codeGraph,
//         embeddingsIndex,
//         tsMorphProjectManagement,
//         workingDirectory,
//     );
// })();
