/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LLMProviderAPIKeys } from '../sidecar/providerConfigTypes';
import { LLMProvider, LLMTypeVariant, SidecarVariableTypes } from '../sidecar/types';

type SidecarFileContent = {
	file_path: string;
	file_content: string;
	language: string;
};

export type UserContext = {
	variables: SidecarVariableTypes[];
	file_content_map: SidecarFileContent[];
	terminal_selection: string | undefined;
	folder_paths: string[];
};

export type SymbolIdentifier = {
	symbol_name: string;
	fs_file_path?: string;
};

type ActiveWindowData = {
	file_path: string;
	file_content: string;
	language: string;
};

export type ProbeAgentBody = {
	query: string;
	editor_url: string;
	request_id: string;
	model_config: Record<string, any>;
	user_context: UserContext;
	active_window_data?: ActiveWindowData;
};

export type CodeEditAgentBody = {
	user_query: string;
	editor_url: string;
	request_id: string;
	user_context: UserContext;
	active_window_data?: ActiveWindowData;
	root_directory: string | undefined;
	codebase_search: boolean;
	anchor_editing: boolean;
};

export type AnchorSessionStart = {
	editor_url: string;
	request_id: string;
	user_context: UserContext;
	active_window_data?: ActiveWindowData;
	root_directory: string | undefined;
}

export type SideCarAgentEvent = SideCarAgentKeepAliveEvent | SideCarAgentUIEvent;

interface SideCarAgentKeepAliveEvent {
	keep_alive: 'alive';
}

interface SideCarAgentUIEvent {
	request_id: string;
	event: UIEvent;
}

interface RequestEventProbeFinished {
	reply: string;
}

interface RequestEvents {
	ProbingStart?: {};
	ProbeFinished?: RequestEventProbeFinished;
}

type FrameworkEvent = {
	RepoMapGenerationStart: string;
	RepoMapGenerationFinished: string;
	LongContextSearchStart: string;
	LongContextSearchFinished: string;
	InitialSearchSymbols: InitialSearchSymbols;
	OpenFile: OpenFileRequestFrameworkEvent;
	CodeIterationFinished: string;
	ReferenceFound: FoundReference;
};

interface UIEvent {
	SymbolEvent: SymbolEventRequest;
	ToolEvent: ToolInput;
	CodebaseEvent: SymbolInputEvent;
	SymbolLoctationUpdate: SymbolLocation;
	SymbolEventSubStep: SymbolEventSubStepRequest;
	RequestEvent: RequestEvents;
	EditRequestFinished: string;
	FrameworkEvent: FrameworkEvent;
}

interface SymbolEventSubStepRequest {
	symbol_identifier: SymbolIdentifier;
	event: SymbolEventSubStep;
}

interface SymbolEventProbeRequest {
	SubSymbolSelection: {};
	ProbeDeeperSymbol: {};
	ProbeAnswer: string;
}

interface SymbolEventGoToDefinitionRequest {
	fs_file_path: string;
	range: SidecarRequestRange;
	thinking: string;
}

interface EditedCodeStreamingRequestEvent {
	Delta: string;
}

interface EditedCodeStreamingRequest {
	edit_request_id: string;
	range: SidecarRequestRange;
	fs_file_path: string;
	event: 'Start' | 'End' | EditedCodeStreamingRequestEvent;
	updated_code: string | null | undefined;
}

interface SymbolEventEditRequest {
	RangeSelectionForEdit: RangeSelectionForEditRequest;
	InsertCode: InsertCodeForEditRequest;
	EditCode: EditedCodeForEditRequest;
	CodeCorrectionTool: CodeCorrectionToolSelection;
	EditCodeStreaming: EditedCodeStreamingRequest;
}

interface RangeSelectionForEditRequest {
	range: SidecarRequestRange;
	fs_file_path: string;
}

interface InsertCodeForEditRequest {
	range: SidecarRequestRange;
	fs_file_path: string;
}

interface EditedCodeForEditRequest {
	range: SidecarRequestRange;
	fs_file_path: string;
	new_code: string;
}

interface CodeCorrectionToolSelection {
	range: SidecarRequestRange;
	fs_file_path: string;
	tool_use: string;
}

interface SymbolEventSubStep {
	Probe?: SymbolEventProbeRequest;
	GoToDefinition?: SymbolEventGoToDefinitionRequest;
	Edit?: SymbolEventEditRequest;
}

interface SymbolLocation {
	snippet: Snippet;
	symbol_identifier: SymbolIdentifier;
}

interface SymbolInputEvent {
	context: UserContext;
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_keys: LLMProviderAPIKeys;
	user_query: string;
	request_id: string;
	swe_bench_test_endpoint?: string;
	repo_map_fs_path?: string;
	gcloud_access_token?: string;
	swe_bench_id?: string;
	swe_bench_git_dname?: string;
	swe_bench_code_editing?: LLMProperties;
	swe_bench_gemini_api_keys?: LLMProperties;
	swe_bench_long_context_editing?: LLMProperties;
}

interface LLMProperties {
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_keys: LLMProviderAPIKeys;
}

interface ToolProperties {
	swe_bench_test_endpoint?: string;
	swe_bench_code_editing_llm?: LLMProperties;
	swe_bench_reranking_llm?: LLMProperties;
}

interface SymbolEventRequest {
	symbol: SymbolIdentifier;
	event: SymbolEvent;
	tool_properties: ToolProperties;
}

interface SymbolEvent {
	InitialRequest: InitialRequestData;
	AskQuestion: AskQuestionRequest;
	UserFeedback: {};
	Delete: {};
	Edit: SymbolToEditRequest;
	Outline: {};
	Probe: SymbolToProbeRequest;
}

interface InitialRequestData {
	original_question: string;
	plan_if_available?: string;
}

interface AskQuestionRequest {
	question: string;
}

interface SymbolToEdit {
	outline: boolean;
	range: SidecarRequestRange;
	fs_file_path: string;
	symbol_name: string;
	instructions: string[];
	is_new: boolean;
}

interface InitialSearchSymbols {
	request_id: string;
	symbols: InitialSearchSymbolInformation[];
}

interface OpenFileRequestFrameworkEvent {
	fs_file_path: string;
}

interface FoundReference {
	request_id: string;
	fs_file_path: string;
}

interface InitialSearchSymbolInformation {
	fs_file_path: string;
	symbol_name: string;
	is_new: boolean;
	thinking: string;
	range: Range;
}

interface SymbolToEditRequest {
	symbols: SymbolToEdit[];
	symbol_identifier: SymbolIdentifier;
}

interface SymbolToProbeHistory {
	symbol: string;
	fs_file_path: string;
	content: string;
	question: string;
}

interface SymbolToProbeRequest {
	symbol_identifier: SymbolIdentifier;
	probe_request: string;
	original_request: string;
	original_request_id: string;
	history: SymbolToProbeHistory[];
}

interface ToolInput {
	CodeEditing?: CodeEdit;
	LSPDiagnostics?: LSPDiagnostics;
	FindCodeSnippets?: FindCodeSnippets;
	ReRank?: ReRankEntriesForBroker;
	CodeSymbolUtilitySearch?: CodeSymbolUtilitySearch;
	RequestImportantSymbols?: CodeSymbolImportantRequest;
	RequestImportantSybmolsCodeWide?: CodeSymbolImportantWideSearch;
	GoToDefinition?: SidecarGoToDefinitionRequest;
	GoToReference?: SidecarGoToReferencesRequest;
	OpenFile?: OpenFileRequest;
	GrepSingleFile?: FindInFileRequest;
	SymbolImplementations?: SidecarGoToImplementationRequest;
	FilterCodeSnippetsForEditing?: CodeToEditFilterRequest;
	FilterCodeSnippetsForEditingSingleSymbols?: CodeToEditSymbolRequest;
	EditorApplyChange?: EditorApplyRequest;
	QuickFixRequest?: SidecarQuickFixRequest;
	QuickFixInvocationRequest?: LSPQuickFixInvocationRequest;
	CodeCorrectnessAction?: CodeCorrectnessRequest;
	CodeEditingError?: CodeEditingErrorRequest;
	ClassSymbolFollowup?: ClassSymbolFollowupRequest;
	ProbeCreateQuestionForSymbol?: ProbeQuestionForSymbolRequest;
	ProbeEnoughOrDeeper?: ProbeEnoughOrDeeperRequest;
	ProbeFilterSnippetsSingleSymbol?: CodeToProbeSubSymbolRequest;
	ProbeSubSymbol?: CodeToEditFilterRequest;
	ProbePossibleRequest?: CodeSymbolToAskQuestionsRequest;
	ProbeQuestionAskRequest?: CodeSymbolToAskQuestionsRequest;
	ProbeFollowAlongSymbol?: CodeSymbolFollowAlongForProbing;
	ProbeSummarizeAnswerRequest?: CodeSymbolProbingSummarize;
	RepoMapSearch?: RepoMapSearchQuery;
	SWEBenchTest?: SWEBenchTestRequest;
	TestOutputCorrection?: TestOutputCorrectionRequest;
	CodeSymbolFollowInitialRequest?: CodeSymbolFollowInitialRequest;
	PlanningBeforeCodeEdit?: PlanningBeforeCodeEditRequest;
	NewSubSymbolForCodeEditing?: NewSubSymbolRequiredRequest;
	GrepSymbolInCodebase?: LSPGrepSymbolInCodebaseRequest;
}

interface CodeEdit {
	code_above?: string;
	code_below?: string;
	fs_file_path: string;
	code_to_edit: string;
	extra_context: string;
	language: string;
	model: LLMTypeVariant;
	instruction: string;
	api_key: LLMProviderAPIKeys;
	provider: LLMProvider;
	is_swe_bench_initial_edit: boolean;
	is_new_symbol_request?: string;
}

export type LSPDiagnostics = {
	fs_file_path: string;
	range: SidecarRequestRange;
	editor_url: string;
};

export interface FindCodeSnippets {
	fs_file_path: string;
	file_content: string;
	language: string;
	file_path: string;
	user_query: string;
	llm_type: LLMTypeVariant;
	api_key: LLMProviderAPIKeys;
	provider: LLMProvider;
}

interface ReRankCodeSnippet {
	fs_file_path: string;
	range: SidecarRequestRange;
	content: string;
	language: string;
}

interface ReRankDocument {
	document_name: string;
	document_path: string;
	content: string;
}

interface ReRankWebExtract {
	url: string;
	content: string;
}

interface ReRankEntry {
	CodeSnippet: ReRankCodeSnippet;
	Document: ReRankDocument;
	WebExtract: ReRankWebExtract;
}

interface ReRankEntries {
	id: number;
	entry: ReRankEntry;
}

interface ReRankRequestMetadata {
	model: LLMTypeVariant;
	query: string;
	provider_keys: Record<string, any>;
	provider: LLMProvider;
}

export interface ReRankEntriesForBroker {
	entries: ReRankEntries[];
	metadata: ReRankRequestMetadata;
}

export interface CodeSymbolUtilitySearch {
	user_query: string;
	definitions_already_present: string[];
	fs_file_path: string;
	fs_file_content: string;
	selection_range: SidecarRequestRange;
	language: string;
	llm_type: LLMTypeVariant;
	llm_provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
	user_context: UserContext;
}

interface CodeSymbolImportantRequest {
	symbol_identifier?: string;
	history: string[];
	fs_file_path: string;
	fs_file_content: string;
	selection_range: SidecarRequestRange;
	language: string;
	llm_type: LLMTypeVariant;
	llm_provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
	query: string;
}


export interface CodeSymbolImportantWideSearch {
	user_context: UserContext;
	user_query: string;
	llm_type: LLMTypeVariant;
	llm_provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
	file_extension_filters: Set<string>;
}

export type SidecarGoToDefinitionRequest = {
	fs_file_path: string;
	position: SidecarRequestPosition;
};

interface OpenFileRequest {
	fs_file_path: string;
	editor_url: string;
}

interface FindInFileRequest {
	file_contents: string;
	file_symbol: string;
}

export type SidecarGoToDefinitionResponse = {
	definitions: FileAndRange[];
};

export type FileAndRange = {
	fs_file_path: string;
	range: SidecarRequestRange;
};

export type SidecarOpenFileToolRequest = {
	fs_file_path: string;
};

export type SidecarOpenFileToolResponse = {
	fs_file_path: string;
	file_contents: string;
	language: string;
	exists: boolean;
};

export type SidecarGoToImplementationRequest = {
	fs_file_path: string;
	position: SidecarRequestPosition;
	editor_url: string;
};

export enum OutlineNodeType {
	ClassDefinition = 'ClassDefinition',
	Class = 'Class',
	ClassName = 'ClassName',
	Function = 'Function',
	FunctionName = 'FunctionName',
	FunctionBody = 'FunctionBody',
	FunctionClassName = 'FunctionClassName',
	FunctionParameterIdentifier = 'FunctionParameterIdentifier',
	Decorator = 'Decorator',
}

export type OutlineNodeContent = {
	range: SidecarRequestRange;
	name: string;
	'r#type': OutlineNodeType;
	content: string;
	fs_file_path: string;
	identifier_range: SidecarRequestRange;
	body_range: SidecarRequestRange;
};

export type Snippet = {
	range: SidecarRequestRange;
	symbol_name: string;
	fs_file_path: string;
	content: string;
	language?: string;
	// this represents completely a snippet of code which is a logical symbol
	outline_node_content: OutlineNodeContent;
};

export type ProbeQuestionForSymbolRequest = {
	symbol_name: string;
	next_symbol_name: string;
	next_symbol_file_path: string;
	history: string[];
	hyperlinks: string[];
	original_user_query: string;
	llm_properties: LLMProperties;
};

export type ProbeEnoughOrDeeperRequest = {
	symbol_name: string;
	xml_string: string;
	query: string;
	llm_properties: LLMProperties;
};

export type CodeToProbeSubSymbolRequest = {
	xml_symbol: string;
	query: string;
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
};

export type CodeToEditFilterRequest = {
	snippets: Snippet[];
	query: string;
	llm_type: LLMTypeVariant;
	llm_provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
};

export type CodeSymbolToAskQuestionsRequest = {
	history: string;
	symbol_identifier: string;
	fs_file_path: string;
	language: string;
	extra_data: string;
	code_above?: string;
	code_below?: string;
	code_in_selection: string;
	llm_type: LLMTypeVariant;
	provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
	query: string;
};

export type CodeSymbolFollowAlongForProbing = {
	history: string;
	symbol_identifier: string;
	fs_file_path: string;
	language: string;
	next_symbol_names: string[];
	next_symbol_outlines: string[];
	code_above?: string;
	code_below?: string;
	code_in_selection: string;
	llm_type: LLMTypeVariant;
	provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
	query: string;
	next_symbol_link: string;
};

export type CodeSubSymbolProbingResult = {
	symbol_name: string;
	fs_file_path: string;
	probing_results: string[];
	content: string;
};

export type CodeSymbolProbingSummarize = {
	query: string;
	history: string;
	symbol_identifier: string;
	symbol_outline: string;
	fs_file_path: string;
	probing_results: CodeSubSymbolProbingResult[];
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
};

export type RepoMapSearchQuery = {
	repo_map: string;
	user_query: string;
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
};

export type SWEBenchTestRequest = {
	swe_bench_test_endpoint: string;
};

export type TestOutputCorrectionRequest = {
	fs_file_path: string;
	file_contents: string;
	user_instructions: string;
	code_above: string | undefined;
	code_below: string | undefined;
	code_in_selection: string;
	original_code: string;
	language: string;
	test_output_logs: string;
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_keys: LLMProviderAPIKeys;
	extra_code_context: string;
};

export type CodeSymbolFollowInitialRequest = {
	code_symbol_content: string[];
	user_query: string;
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_keys: LLMProviderAPIKeys;
};

export type PlanningBeforeCodeEditRequest = {
	user_query: string;
	files_with_content: Record<string, string>;
	original_plan: string;
	llm_properties: LLMProperties;
};

export type NewSubSymbolRequiredRequest = {
	user_query: string;
	plan: string;
	symbol_content: string;
	llm_properties: LLMProperties;
};

export type LSPGrepSymbolInCodebaseRequest = {
	editor_url: string;
	search_string: string;
};

export type CodeToEditSymbolRequest = {
	xml_symbol: string;
	query: string;
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_key: LLMProviderAPIKeys;
};

export type EditorApplyRequest = {
	fs_file_path: string;
	edited_content: string;
	selected_range: SidecarRequestRange;
	editor_url: string;
};

export type SidecarGoToImplementationResponse = {
	implementation_locations: FileAndRange[];
};

export type SidecarSymbolSearchRequest = {
	search_string: string;
};

export type SidecarGoToReferencesRequest = {
	fs_file_path: string;
	position: SidecarRequestPosition;
};

export type SidecarGoToRefernecesResponse = {
	reference_locations: FileAndRange[];
};

export type SidecarSymbolSearchInformation = {
	name: String;
	kind: String;
	fs_file_path: String;
	range: SidecarRequestRange;
};

export type SidecarSymbolSearchResponse = {
	locations: SidecarSymbolSearchInformation[];
};

export type SidecarQuickFixRequest = {
	fs_file_path: string;
	editor_url: string;
	range: SidecarRequestRange;
	request_id: string;
};

// Keeping it simple for now
export type SidecarQuickFixResponse = {
	options: {
		label: string;
		index: number;
	}[];
};

export type LSPQuickFixInvocationRequest = {
	request_id: string;
	index: number;
	fs_file_path: string;
	editor_url: string;
};

export type Diagnostic = {
	diagnostic: string;
	range: SidecarRequestRange;
};

export type QuickFixOption = {
	label: string;
	number: number;
};

export type CodeCorrectnessRequest = {
	fs_file_contents: string;
	fs_file_path: string;
	code_above?: string;
	code_below?: string;
	code_in_selection: string;
	symbol_name: string;
	instruction: string;
	previous_code: string;
	diagnostics: Diagnostic[];
	quick_fix_actions: QuickFixOption[];
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_keys: LLMProviderAPIKeys;
};

export type CodeEditingErrorRequest = {
	fs_file_path: string;
	code_above?: string;
	code_below?: string;
	code_in_selection: string;
	extra_context: string;
	original_code: string;
	error_instructions: string;
	previous_instructions: string;
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_keys: LLMProviderAPIKeys;
};

export type ClassSymbolFollowupRequest = {
	fs_file_path: string;
	original_code: string;
	language: string;
	edited_code: string;
	instructions: string;
	llm: LLMTypeVariant;
	provider: LLMProvider;
	api_keys: LLMProviderAPIKeys;
};

export type SidecarQuickFixInvocationResponse = {
	request_id: string;
	invocation_success: boolean;
};

export type SidecarInlayHintsRequest = {
	fs_file_path: string;
	range: SidecarRequestRange;
};

export type SidecarInlayHintsResponsePart = {
	position: SidecarRequestPosition;
	padding_left: boolean;
	padding_right: boolean;
	// the value of the inlay hint
	values: string[];
};

/**
 * Contains the response from grabbing the inlay hints in a given range
 */
export type SidecarInlayHintResponse = {
	parts: SidecarInlayHintsResponsePart[];
};

export type SidecarApplyEditsRequest = {
	fs_file_path: string;
	edited_content: string;
	selected_range: SidecarRequestRange;
	apply_directly: boolean;
};

export interface SidecarRequestRange {
	startPosition: SidecarRequestPosition;
	endPosition: SidecarRequestPosition;
}

export interface SidecarRequestPosition {
	line: number;
	character: number;
	byteOffset: number;
}

export interface SidecarResponseRange {
	startPosition: SidecarResponsePosition;
	endPosition: SidecarResponsePosition;
}

export interface SidecarResponsePosition {
	line: number;
	character: number;
	byteOffset: number;
}

export type SidecarApplyEditsResponse = {
	fs_file_path: string;
	success: boolean;
	new_range: SidecarResponseRange;
};

export type SidecarDiagnosticsResponse = {
	diagnostic: string;
	range: SidecarResponseRange;
};
