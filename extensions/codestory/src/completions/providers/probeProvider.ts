/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as vscode from 'vscode';

import { AnswerSplitOnNewLineAccumulatorStreaming, readJsonFile, reportAgentEventsToChat, StreamProcessor } from '../../chatState/convertStreamToMessage';
import postHogClient from '../../posthog/client';
import { applyEdits, applyEditsDirectly, Limiter } from '../../server/applyEdits';
import { handleRequest } from '../../server/requestHandler';
import { EditedCodeStreamingRequest, SideCarAgentEvent, SidecarApplyEditsRequest } from '../../server/types';
import { SideCarClient } from '../../sidecar/client';
import { getUniqueId } from '../../utilities/uniqueId';

export class AideProbeProvider implements vscode.Disposable {
	private _sideCarClient: SideCarClient;
	private _editorUrl: string | undefined;
	private _rootPath: string;
	private _limiter = new Limiter(1);
	private editsMap = new Map();

	private _requestHandler: http.Server | null = null;
	private _openResponseStream: vscode.ProbeResponseStream | undefined;
	private _iterationEdits = new vscode.WorkspaceEdit();

	private async isPortOpen(port: number): Promise<boolean> {
		return new Promise((resolve, _) => {
			const s = net.createServer();
			s.once('error', (err) => {
				s.close();
				// @ts-ignore
				if (err['code'] === 'EADDRINUSE') {
					resolve(false);
				} else {
					resolve(false); // or throw error!!
					// reject(err);
				}
			});
			s.once('listening', () => {
				resolve(true);
				s.close();
			});
			s.listen(port);
		});
	}

	private async getNextOpenPort(startFrom: number = 42427) {
		let openPort: number | null = null;
		while (startFrom < 65535 || !!openPort) {
			if (await this.isPortOpen(startFrom)) {
				openPort = startFrom;
				break;
			}
			startFrom++;
		}
		return openPort;
	}

	constructor(
		sideCarClient: SideCarClient,
		rootPath: string,
	) {
		this._sideCarClient = sideCarClient;
		this._rootPath = rootPath;

		// Server for the sidecar to talk to the editor
		this._requestHandler = http.createServer(
			handleRequest(this.provideEdit.bind(this), this.provideEditStreamed.bind(this))
		);
		this.getNextOpenPort().then((port) => {
			if (port === null) {
				throw new Error('Could not find an open port');
			}

			// can still grab it by listenting to port 0
			this._requestHandler?.listen(port);
			const editorUrl = `http://localhost:${port}`;
			console.log('editorUrl', editorUrl);
			this._editorUrl = editorUrl;
			// console.log(this._editorUrl);
		});

		vscode.aideProbe.registerProbeResponseProvider(
			'aideProbeProvider',
			{
				provideProbeResponse: this.provideProbeResponse.bind(this),
				onDidSessionAction: this.sessionFollowup.bind(this),
				onDidUserAction: this.userFollowup.bind(this),
			}
		);
	}

	async sessionFollowup(sessionAction: vscode.AideProbeSessionAction) {
		if (sessionAction.action.type === 'newIteration') {
			// @theskcd - This is where we can accept the iteration
			console.log('newIteration', sessionAction);
			await this._sideCarClient.codeSculptingFollowup(sessionAction.action.newPrompt, sessionAction.sessionId);
		}

		if (sessionAction.action.type === 'followUpRequest') {
			console.log('followUpRequest');
			this._iterationEdits = new vscode.WorkspaceEdit();
			await this._sideCarClient.codeSculptingFollowups(sessionAction.sessionId, this._rootPath);
		}

		postHogClient?.capture({
			distinctId: getUniqueId(),
			event: sessionAction.action.type,
			properties: {
				platform: os.platform(),
				requestId: sessionAction.sessionId,
			},
		});
	}

	async userFollowup(userAction: vscode.AideProbeUserAction) {
		if (userAction.type === 'contextChange') {
			console.log('contextChange');
			if (!this._editorUrl) {
				console.log('skipping_no_editor_url');
				return;
			}
			await this._sideCarClient.warmupCodeSculptingCache(userAction.newContext, this._editorUrl);
		}
		postHogClient?.capture({
			distinctId: getUniqueId(),
			event: userAction.type,
			properties: {
				platform: os.platform(),
			},
		});
	}

	async provideEditStreamed(request: EditedCodeStreamingRequest): Promise<{
		fs_file_path: String;
		success: boolean;
	}> {
		if (!this._openResponseStream) {
			return {
				fs_file_path: '',
				success: false,
			};
		}
		const editStreamEvent = request;
		const fileDocument = editStreamEvent.fs_file_path;
		const document = await vscode.workspace.openTextDocument(fileDocument);
		if (document === undefined || document === null) {
			return {
				fs_file_path: '',
				success: false,
			};
		}
		const documentLines = document.getText().split(/\r\n|\r|\n/g);
		if ('Start' === editStreamEvent.event) {
			console.log('editStreaming.start', editStreamEvent.fs_file_path);
			console.log(editStreamEvent.range);
			this.editsMap.set(editStreamEvent.edit_request_id, {
				answerSplitter: new AnswerSplitOnNewLineAccumulatorStreaming(),
				streamProcessor: new StreamProcessor(
					this._openResponseStream,
					documentLines,
					undefined,
					vscode.Uri.file(editStreamEvent.fs_file_path),
					editStreamEvent.range,
					null,
					this._iterationEdits,
				)
			});
		} else if ('End' === editStreamEvent.event) {
			// drain the lines which might be still present
			const editsManager = this.editsMap.get(editStreamEvent.edit_request_id);
			while (true) {
				const currentLine = editsManager.answerSplitter.getLine();
				if (currentLine === null) {
					break;
				}
				await editsManager.streamProcessor.processLine(currentLine);
			}
			editsManager.streamProcessor.cleanup();
			// delete this from our map
			this.editsMap.delete(editStreamEvent.edit_request_id);
			// we have the updated code (we know this will be always present, the types are a bit meh)
		} else if (editStreamEvent.event.Delta) {
			const editsManager = this.editsMap.get(editStreamEvent.edit_request_id);
			if (editsManager !== undefined) {
				editsManager.answerSplitter.addDelta(editStreamEvent.event.Delta);
				while (true) {
					const currentLine = editsManager.answerSplitter.getLine();
					if (currentLine === null) {
						break;
					}
					await editsManager.streamProcessor.processLine(currentLine);
				}
			}
		}
		return {
			fs_file_path: '',
			success: true,
		};
	}

	async provideEdit(request: SidecarApplyEditsRequest): Promise<{
		fs_file_path: String;
		success: boolean;
	}> {
		if (request.apply_directly) {
			applyEditsDirectly(request);
			return {
				fs_file_path: request.fs_file_path,
				success: true,
			};
		}
		if (!this._openResponseStream) {
			console.log('returning early over here');
			return {
				fs_file_path: request.fs_file_path,
				success: true,
			};
		}
		const response = await applyEdits(request, this._openResponseStream, this._iterationEdits);
		return response;
	}

	private async provideProbeResponse(request: vscode.ProbeRequest, response: vscode.ProbeResponseStream, token: vscode.CancellationToken) {
		if (!this._editorUrl) {
			return;
		}

		this._openResponseStream = response;
		let { query } = request;

		query = query.trim();

		const startTime = process.hrtime();

		postHogClient?.capture({
			distinctId: getUniqueId(),
			event: 'probe_requested',
			properties: {
				platform: os.platform(),
				query,
				requestId: request.requestId,
			},
		});

		//if there is a selection present in the references: this is what it looks like:
		//const isAnchorEditing = isAnchorBasedEditing(request.mode);

		//let probeResponse: AsyncIterableIterator<SideCarAgentEvent>;
		//
		//if (request.mode === 'AGENTIC' || request.mode === 'ANCHORED') {
		//	probeResponse = this._sideCarClient.startAgentCodeEdit(query, request.references, this._editorUrl, request.requestId, request.codebaseSearch, isAnchorEditing);
		//} else {
		//	probeResponse = this._sideCarClient.startAgentProbe(query, request.references, this._editorUrl, request.requestId,);
		//}

		// Use dummy data: Start
		const extensionRoot = vscode.extensions.getExtension('codestory-ghost.codestoryai')?.extensionPath;
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		if (!extensionRoot || !workspaceRoot) {
			return {};
		}

		const that = this;
		const jsonArr = readJsonFile(`${extensionRoot}/src/completions/providers/dummydata.json`);
		const probeResponse = (async function* (arr) {
			for (const original of arr) {
				const itemString = JSON.stringify(original).replace(/\/Users\/nareshr\/github\/codestory\/sidecar/g, workspaceRoot);
				const item = JSON.parse(itemString) as SideCarAgentEvent;
				if ('request_id' in item && item.event.SymbolEventSubStep && item.event.SymbolEventSubStep.event.Edit) {
					const editSubStep = item.event.SymbolEventSubStep.event.Edit;
					if (editSubStep.EditCode) {
						const editEvent = editSubStep.EditCode;
						that.provideEdit({
							apply_directly: false,
							fs_file_path: editEvent.fs_file_path,
							selected_range: editEvent.range,
							edited_content: editEvent.new_code
						});
					}
				}
				yield item;
			}
		})(jsonArr);
		// Use dummy data: End

		const isEditMode = request.mode === 'AGENTIC' || request.mode === 'ANCHORED';
		await reportAgentEventsToChat(isEditMode, probeResponse, response, request.requestId, token, this._sideCarClient, this._iterationEdits, this._limiter);

		const endTime = process.hrtime(startTime);
		postHogClient?.capture({
			distinctId: getUniqueId(),
			event: 'probe_completed',
			properties: {
				platform: os.platform(),
				query,
				timeElapsed: `${endTime[0]}s ${endTime[1] / 1000000}ms`,
				requestId: request.requestId,
			},
		});

		return {
			iterationEdits: this._iterationEdits,
		};
	}

	dispose() {
		this._requestHandler?.close();
	}
}

//function isAnchorBasedEditing(mode: vscode.AideProbeMode): boolean {
//	if (mode === 'ANCHORED') {
//		return true;
//	} else {
//		return false;
//	}
//}
