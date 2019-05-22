/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { parseDiff, getModifiedContentFromDiffHunk, DiffChangeType, DiffHunk } from '../../common/diffHunk';
import { getZeroBased, getAbsolutePosition, getPositionInDiff, mapHeadLineToDiffHunkPosition } from '../../common/diffPositionMapping';
import { SlimFileChange, GitChangeType } from '../../common/file';
import Logger from '../../common/logger';
import { Resource } from '../../common/resources';
import { fromPRUri, toPRUri } from '../../common/uri';
import { groupBy, uniqBy } from '../../common/utils';
import { DescriptionNode } from './descriptionNode';
import { RemoteFileChangeNode, InMemFileChangeNode, GitFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';
import { getInMemPRContentProvider } from '../inMemPRContentProvider';
import { IComment } from '../../common/comment';
import { GHPRComment, GHPRCommentThread } from '../../github/prComment';
import { PullRequestManager } from '../../github/pullRequestManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { CommentHandler, createVSCodeCommentThread, getReactionGroup, parseGraphQLReaction, updateCommentThreadLabel, updateCommentReviewState, updateCommentReactions } from '../../github/utils';
import { registerCommentHandler } from '../../commentThreadResolver';

export function provideDocumentComments(
	uri: vscode.Uri,
	isBase: boolean,
	fileChange: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode),
	matchingComments: IComment[]) {

	if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
		return;
	}

	// Partial file change indicates that the file content is only the diff, so the entire
	// document can be commented on.
	const commentingRanges = fileChange.isPartial
		? [new vscode.Range(0, 0, 0, 0)]
		: getCommentingRanges(fileChange.diffHunks, isBase);

	if (!matchingComments || !matchingComments.length) {
		return {
			threads: [],
			commentingRanges
		};
	}

	let sections = groupBy(matchingComments, comment => String(comment.position));
	let threads: GHPRCommentThread[] = [];

	for (let i in sections) {
		let comments = sections[i];

		const firstComment = comments[0];
		let commentAbsolutePosition = fileChange.isPartial
			? getPositionInDiff(firstComment, fileChange.diffHunks, isBase)
			: getAbsolutePosition(firstComment, fileChange.diffHunks, isBase);

		if (commentAbsolutePosition < 0) {
			continue;
		}

		const pos = new vscode.Position(getZeroBased(commentAbsolutePosition), 0);
		const range = new vscode.Range(pos, pos);

		threads.push({
			threadId: firstComment.id.toString(),
			resource: uri,
			range,
			comments: comments.map(comment => new GHPRComment(comment)), // TODO (rmacfarlane) ensure parent pointer is set
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded
		});
	}

	return {
		threads,
		commentingRanges
	};
}

export function getCommentingRanges(diffHunks: DiffHunk[], isBase: boolean): vscode.Range[] {
	const ranges: vscode.Range[] = [];

	for (let i = 0; i < diffHunks.length; i++) {
		let diffHunk = diffHunks[i];
		let startingLine: number;
		let length: number;
		if (isBase) {
			startingLine = getZeroBased(diffHunk.oldLineNumber);
			length = getZeroBased(diffHunk.oldLength);

		} else {
			startingLine = getZeroBased(diffHunk.newLineNumber);
			length = getZeroBased(diffHunk.newLength);
		}

		ranges.push(new vscode.Range(startingLine, 0, startingLine + length, 0));
	}

	return ranges;
}

function commentsEditedInThread(oldComments: GHPRComment[], newComments: GHPRComment[]): boolean {
	return oldComments.some(oldComment => {
		const matchingComment = newComments.filter(newComment => newComment.commentId === oldComment.commentId);
		if (matchingComment.length !== 1) {
			return true;
		}

		let matchingCommentBody = matchingComment[0].body instanceof vscode.MarkdownString ? matchingComment[0].body.value : matchingComment[0].body;
		let oldCommentBody = oldComment.body instanceof vscode.MarkdownString ? oldComment.body.value : oldComment.body;

		if (matchingCommentBody !== oldCommentBody) {
			return true;
		}

		if (!matchingComment[0].commentReactions && !oldComment.commentReactions) {
			// no comment reactions
			return false;
		}

		if (!matchingComment[0].commentReactions || !oldComment.commentReactions) {
			return true;
		}

		if (matchingComment[0].commentReactions!.length !== oldComment.commentReactions!.length) {
			return true;
		}

		for (let i = 0; i < matchingComment[0].commentReactions!.length; i++) {
			if (matchingComment[0].commentReactions![i].label !== oldComment.commentReactions![i].label ||
				matchingComment[0].commentReactions![i].hasReacted !== oldComment.commentReactions![i].hasReacted) {
				return true;
			}
		}

		return false;
	});
}

export class PRNode extends TreeNode implements CommentHandler, vscode.CommentingRangeProvider, vscode.CommentReactionProvider {
	static ID = 'PRNode';
	public supportedSchemes: string[] = ['pr'];

	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[];
	private _commentController?: vscode.CommentController;
	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _prDocumentCommentProvider?: vscode.Disposable & { commentThreadCache: { [key: string]: vscode.CommentThread[] } };
	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	private _command: vscode.Command;

	public get command(): vscode.Command {
		return this._command;
	}

	public set command(newCommand: vscode.Command) {
		this._command = newCommand;
	}

	public availableReactions: vscode.CommentReaction[] = getReactionGroup();

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		private _prManager: PullRequestManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean
	) {
		super();
		this._fileChanges = [];
		registerCommentHandler(this);
	}

	// #region Tree
	async getChildren(): Promise<TreeNode[]> {
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.prNumber}`, PRNode.ID);
		try {
			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
			}

			const comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
			const data = await this._prManager.getPullRequestFileChangesInfo(this.pullRequestModel);
			const mergeBase = this.pullRequestModel.mergeBase;
			if (!mergeBase) {
				return [];
			}

			const rawChanges = await parseDiff(data, this._prManager.repository, mergeBase);
			let fileChanges = rawChanges.map(change => {
				if (change instanceof SlimFileChange) {
					return new RemoteFileChangeNode(
						this,
						this.pullRequestModel,
						change.status,
						change.fileName,
						change.blobUrl
					);
				}

				const headCommit = this.pullRequestModel.head.sha;
				let changedItem = new InMemFileChangeNode(
					this,
					this.pullRequestModel,
					change.status,
					change.fileName,
					change.previousFileName,
					change.blobUrl,
					toPRUri(vscode.Uri.file(path.resolve(this._prManager.repository.rootUri.fsPath, change.fileName)), this.pullRequestModel, change.baseCommit, headCommit, change.fileName, false, change.status),
					toPRUri(vscode.Uri.file(path.resolve(this._prManager.repository.rootUri.fsPath, change.fileName)), this.pullRequestModel, change.baseCommit, headCommit, change.fileName, true, change.status),
					change.isPartial,
					change.patch,
					change.diffHunks,
					comments.filter(comment => comment.path === change.fileName && comment.position !== null),
				);

				return changedItem;
			});

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRContentProvider().registerTextDocumentContentProvider(this.pullRequestModel.prNumber, this.provideDocumentContent.bind(this));
			}

			// The review manager will register a document comment's provider, so the node does not need to
			if (!this.pullRequestModel.equals(this._prManager.activePullRequest)) {
				if (!this._prDocumentCommentProvider || !this._commentController) {
					await this.pullRequestModel.githubRepository.ensureCommentsProvider();
					this._commentController = this.pullRequestModel.githubRepository.commentsController!;
					this._prDocumentCommentProvider = this.pullRequestModel.githubRepository.commentsProvider!.registerDocumentCommentProvider(this.pullRequestModel.prNumber, this);

					this._disposables.push(this.pullRequestModel.onDidChangeDraftMode(newDraftMode => {
						if (!newDraftMode) {
							this._fileChanges.forEach(fileChange => {
								if (fileChange instanceof InMemFileChangeNode) {
									fileChange.comments.forEach(c => c.isDraft = newDraftMode);
								}
							});
						}

						for (let fileName in this._prDocumentCommentProvider!.commentThreadCache) {
							this._prDocumentCommentProvider!.commentThreadCache[fileName].forEach(thread => {
								updateCommentReviewState(thread, newDraftMode);
							});
						}
					}));
				}

				this._fileChanges = fileChanges;
				await this.refreshExistingPREditors(vscode.window.visibleTextEditors, true);

				this._disposables.push(vscode.window.onDidChangeVisibleTextEditors(async e => {
					// Create Comment Threads when the editor is visible
					// Dispose when the editor is invisible and remove them from the cache map
					// Comment Threads in cache map is updated only when users trigger refresh
					await this.refreshExistingPREditors(e, false);
				}));
			} else {
				await this.pullRequestModel.githubRepository.ensureCommentsProvider();
				this.pullRequestModel.githubRepository.commentsProvider!.clearCommentThreadCache(this.pullRequestModel.prNumber);
				this._fileChanges = fileChanges;
			}

			let result = [new DescriptionNode(this, 'Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this.pullRequestModel), ...this._fileChanges];

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
			return [];
		}
	}

	async refreshExistingPREditors(editors: vscode.TextEditor[], incremental: boolean): Promise<void> {
		let currentPRDocuments = editors.filter(editor => {
			if (editor.document.uri.scheme !== 'pr') {
				return false;
			}

			const params = fromPRUri(editor.document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
				return false;
			}

			return true;
		}).map(editor => {
			return {
				fileName: fromPRUri(editor.document.uri)!.fileName,
				document: editor.document
			};
		});

		for (let fileName in this._prDocumentCommentProvider!.commentThreadCache) {
			let commentThreads = this._prDocumentCommentProvider!.commentThreadCache[fileName];

			let matchedEditor = currentPRDocuments.find(editor => editor.fileName === fileName);

			if (!matchedEditor) {
				commentThreads.forEach(thread => thread.dispose!());
				delete this._prDocumentCommentProvider!.commentThreadCache[fileName];
			}
		}

		if (!incremental) {
			// it's tiggerred by file opening, so we only take care newly opened documents.
			currentPRDocuments = currentPRDocuments.filter(editor => this._prDocumentCommentProvider!.commentThreadCache[editor.fileName] === undefined);
		}

		currentPRDocuments = uniqBy(currentPRDocuments, editor => editor.fileName);

		if (currentPRDocuments.length) {
			// initialize before await
			currentPRDocuments.forEach(editor => {
				if (!this._prDocumentCommentProvider!.commentThreadCache[editor.fileName]) {
					this._prDocumentCommentProvider!.commentThreadCache[editor.fileName] = [];
				}
			});

			const inDraftMode = await this._prManager.validateDraftMode(this.pullRequestModel);
			currentPRDocuments.forEach(editor => {
				let fileChange = this._fileChanges.find(fc => fc.fileName === editor.fileName);

				if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
					return;
				}

				const parentFilePath = fileChange.parentFilePath;
				const filePath = fileChange.filePath;

				let newLeftCommentThreads = provideDocumentComments(parentFilePath, true, fileChange, fileChange.comments);
				let newRightSideCommentThreads = provideDocumentComments(filePath, false, fileChange, fileChange.comments);

				let oldCommentThreads: vscode.CommentThread[] = [];

				if (incremental) {
					let oldLeftSideCommentThreads = this._prDocumentCommentProvider!.commentThreadCache[editor.fileName].filter(thread => thread.resource.toString() === parentFilePath.toString());
					let oldRightSideCommentThreads = this._prDocumentCommentProvider!.commentThreadCache[editor.fileName].filter(thread => thread.resource.toString() === filePath.toString());

					oldCommentThreads = [...oldLeftSideCommentThreads, ...oldRightSideCommentThreads];
				}

				this.updateFileChangeCommentThreads(oldCommentThreads, [...(newLeftCommentThreads ? newLeftCommentThreads.threads : []), ...(newRightSideCommentThreads ? newRightSideCommentThreads.threads : [])], fileChange, inDraftMode);
			});

		}
	}

	async revealComment(comment: IComment) {
		let fileChange = this._fileChanges.find(fc => {
			if (fc.fileName !== comment.path) {
				return false;
			}

			if (fc.pullRequest.head.sha !== comment.commitId) {
				return false;
			}

			return true;
		});

		if (fileChange) {
			await this.reveal(fileChange, { focus: true });
			if (!fileChange.command.arguments) {
				return;
			}
			if (fileChange instanceof InMemFileChangeNode) {
				let lineNumber = fileChange.getCommentPosition(comment);
				const opts = fileChange.opts;
				opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				fileChange.opts = opts;
				await vscode.commands.executeCommand(fileChange.command.command, fileChange);
			} else {
				await vscode.commands.executeCommand(fileChange.command.command, ...fileChange.command.arguments!);
			}
		}
	}

	getTreeItem(): vscode.TreeItem {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._prManager.activePullRequest);

		const {
			title,
			prNumber,
			author,
		} = this.pullRequestModel;

		const {
			login,
		} = author;

		const labelPrefix = (currentBranchIsForThisPR ? '✓ ' : '');
		const tooltipPrefix = (currentBranchIsForThisPR ? 'Current Branch * ' : '');
		const formattedPRNumber = prNumber.toString();
		const label = `${labelPrefix}${title}`;
		const tooltip = `${tooltipPrefix}${title} (#${formattedPRNumber}) by @${login}`;
		const description = `#${formattedPRNumber} by @${login}`;

		return {
			label,
			tooltip,
			description,
			collapsibleState: 1,
			contextValue: 'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.userAvatarUri
				? this.pullRequestModel.userAvatarUri
				: { light: Resource.icons.light.Avatar, dark: Resource.icons.dark.Avatar }
		};
	}

	// #endregion

	// #region Helper
	hasCommentThread(thread: vscode.CommentThread): boolean {
		if (thread.resource.scheme !== 'pr') {
			return false;
		}

		if (this._prManager.activePullRequest && this._prManager.activePullRequest.prNumber === this.pullRequestModel.prNumber) {
			return false;
		}

		let params = fromPRUri(thread.resource);

		if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
			return false;
		}

		return true;
	}

	private createCommentThread(fileName: string, commentThreads: GHPRCommentThread[], inDraftMode: boolean) {
		let threads: vscode.CommentThread[] = [];
		commentThreads.forEach(thread => {
			threads.push(createVSCodeCommentThread(thread, this._commentController!, this.pullRequestModel, inDraftMode, this));
		});

		this._prDocumentCommentProvider!.commentThreadCache[fileName] = threads;
	}

	private updateCommentThreadComments(thread: vscode.CommentThread, newComments: vscode.Comment[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private findMatchingFileNode(uri: vscode.Uri): InMemFileChangeNode {
		const params = fromPRUri(uri);

		if (!params) {
			throw new Error(`${uri.toString()} is not valid PR document`);
		}

		const fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

		if (!fileChange) {
			throw new Error('No matching file found');
		}

		if (fileChange instanceof RemoteFileChangeNode) {
			throw new Error('Comments not supported on remote file changes');
		}

		return fileChange;
	}

	private calculateCommentPosition(fileChange: InMemFileChangeNode, thread: vscode.CommentThread): number {
		const uri = thread.resource;
		const params = fromPRUri(uri);

		const isBase = !!(params && params.isBase);
		const position = mapHeadLineToDiffHunkPosition(fileChange.diffHunks, '', thread.range.start.line + 1, isBase);

		if (position < 0) {
			throw new Error('Comment position cannot be negative');
		}

		return position;
	}

	// #endregion

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === 'pr') {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
				return;
			}

			const fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			const commentingRanges = fileChange.isPartial ? [new vscode.Range(0, 0, 0, 0)] : getCommentingRanges(fileChange.diffHunks, params.isBase);

			return commentingRanges;
		}
	}

	// #endregion

	// #region Incremental updates
	private updateFileChangeCommentThreads(oldCommentThreads: vscode.CommentThread[], newCommentThreads: GHPRCommentThread[], newFileChange: InMemFileChangeNode, inDraftMode: boolean) {
		// remove
		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads = newCommentThreads && newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (!matchingThreads.length) {
				thread.dispose!();
			}
		});

		if (newCommentThreads && newCommentThreads.length) {
			let added: GHPRCommentThread[] = [];
			newCommentThreads.forEach(thread => {
				const matchingCommentThread = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

				if (matchingCommentThread.length === 0) {
					added.push(thread);
					if (thread.resource.scheme === 'file') {
						thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
					}
				}

				matchingCommentThread.forEach(match => {
					if (match.comments.length !== thread.comments.length || commentsEditedInThread(matchingCommentThread[0].comments as GHPRComment[], thread.comments as GHPRComment[])) {
						this.updateCommentThreadComments(match, thread.comments as GHPRComment[]);
					}
				});
			});

			if (added.length) {
				this.createCommentThread(newFileChange.fileName, added, inDraftMode);
			}
		}
	}

	// #endregion

	// #region Document Content Provider
	private async provideDocumentContent(uri: vscode.Uri): Promise<string> {
		let params = fromPRUri(uri);
		if (!params) {
			return '';
		}

		let fileChanges = this._fileChanges.filter(contentChange => (contentChange instanceof InMemFileChangeNode) && contentChange.fileName === params!.fileName);
		if (fileChanges.length) {
			let fileChange = fileChanges[0] as InMemFileChangeNode;
			let readContentFromDiffHunk = fileChange.isPartial || fileChange.status === GitChangeType.ADD || fileChange.status === GitChangeType.DELETE;

			if (readContentFromDiffHunk) {
				if (params.isBase) {
					// left
					let left = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							let diffLine = fileChange.diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Delete) {
								left.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								left.push(diffLine.text);
							}
						}
					}

					return left.join('\n');
				} else {
					let right = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							let diffLine = fileChange.diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								right.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Delete) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								right.push(diffLine.text);
							}
						}
					}

					return right.join('\n');
				}
			} else {
				const originalFileName = fileChange.status === GitChangeType.RENAME ? fileChange.previousFileName : fileChange.fileName;
				const originalFilePath = path.join(this._prManager.repository.rootUri.fsPath, originalFileName!);
				const originalContent = await this._prManager.repository.show(params.baseCommit, originalFilePath);

				if (params.isBase) {
					return originalContent;
				} else {
					return getModifiedContentFromDiffHunk(originalContent, fileChange.patch);
				}
			}
		}
		Logger.appendLine(`PR> can not find content for document ${uri.toString()}`);
		return '';
	}

	// #endregion

	// #region comment
	public async createOrReplyComment(thread: vscode.CommentThread, input: string) {
		if (await this._prManager.authenticate()) {
			const fileChange = this.findMatchingFileNode(thread.resource);
			let rawComment: IComment | undefined;

			if (thread.comments.length) {
				const replyingTo = thread.comments[0] as GHPRComment;
				rawComment = await this._prManager.createCommentReply(this.pullRequestModel, input, replyingTo._rawComment);
			} else {
				const position = this.calculateCommentPosition(fileChange, thread);
				rawComment = await this._prManager.createComment(this.pullRequestModel, input, fileChange.fileName, position);

				// Add new thread to cache
				const existingThreads = this._prDocumentCommentProvider!.commentThreadCache[fileChange.fileName];
				if (existingThreads) {
					this._prDocumentCommentProvider!.commentThreadCache[fileChange.fileName] = [...existingThreads, thread];
				} else {
					this._prDocumentCommentProvider!.commentThreadCache[fileChange.fileName] = [thread];
				}
			}

			fileChange.comments.push(rawComment!);
			const vscodeComment = new GHPRComment(rawComment!, thread);
			this.updateCommentThreadComments(thread, [...thread.comments, vscodeComment]);
		}
	}

	public async editComment(thread: vscode.CommentThread, comment: GHPRComment): Promise<void> {
		if (await this._prManager.authenticate()) {
			const fileChange = this.findMatchingFileNode(thread.resource);
			const existingComment = (comment as (vscode.Comment & { _rawComment: IComment }))._rawComment;
			if (!existingComment) {
				throw new Error('Unable to find comment');
			}

			const rawComment = await this._prManager.editReviewComment(this.pullRequestModel, existingComment, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body);

			const index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (index > -1) {
				fileChange.comments.splice(index, 1, rawComment);
			}

			const i = thread.comments.findIndex(c => (c as GHPRComment)._rawComment.id.toString() === comment.commentId);
			if (i > -1) {
				const vscodeComment = new GHPRComment(rawComment, thread);

				const comments = thread.comments.slice(0);
				comments.splice(i, 1, vscodeComment);
				thread.comments = comments;
			}
		}
	}

	public async deleteComment(thread: vscode.CommentThread, comment: GHPRComment): Promise<void> {
		await this._prManager.deleteReviewComment(this.pullRequestModel, comment.commentId);
		const fileChange = this.findMatchingFileNode(thread.resource);
		let index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
		if (index > -1) {
			fileChange.comments.splice(index, 1);
		}

		thread.comments = thread.comments.filter((c: GHPRComment) => c.commentId !== comment.commentId);

		if (thread.comments.length === 0) {
			let rawComment = (comment as vscode.Comment & { _rawComment: IComment })._rawComment;

			if (rawComment.path) {
				let threadIndex = this._prDocumentCommentProvider!.commentThreadCache[rawComment.path].findIndex(cachedThread => cachedThread.threadId === thread.threadId);
				this._prDocumentCommentProvider!.commentThreadCache[rawComment.path].splice(threadIndex, 1);
			}

			thread.dispose!();
		}

		await this._prManager.validateDraftMode(this.pullRequestModel);
	}
	// #endregion

	// #region Review
	public async startReview(thread: vscode.CommentThread, input: string): Promise<void> {
		await this._prManager.startReview(this.pullRequestModel);
		await this.createOrReplyComment(thread, input);
	}

	public async finishReview(thread: vscode.CommentThread, input: string): Promise<void> {
		try {
			this.createOrReplyComment(thread, input);
			await this._prManager.submitReview(this.pullRequestModel);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	public async deleteReview(): Promise<void> {
		const { deletedReviewId, deletedReviewComments } = await this._prManager.deleteReview(this.pullRequestModel);

		// Group comments by file and then position to create threads.
		const commentsByPath = groupBy(deletedReviewComments, comment => comment.path || '');

		for (let filePath in commentsByPath) {
			const matchingFileChange = this._fileChanges.find(fileChange => fileChange.fileName === filePath);

			if (matchingFileChange && matchingFileChange instanceof InMemFileChangeNode) {
				matchingFileChange.comments = matchingFileChange.comments.filter(comment => comment.pullRequestReviewId !== deletedReviewId);
				if (this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName]) {
					let threads: vscode.CommentThread[] = [];

					this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName].forEach(thread => {
						this.updateCommentThreadComments(thread, thread.comments.filter((comment: GHPRComment) => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId)));
						if (!thread.comments.length) {
							thread.dispose!();
						} else {
							threads.push(thread);
						}
					});

					if (threads.length) {
						this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName] = threads;
					} else {
						delete this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName];
					}
				}
			}
		}
	}

	// #endregion

	// #region Reaction
	async toggleReaction(document: vscode.TextDocument, comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		if (document.uri.scheme !== 'pr') {
			return;
		}

		const params = fromPRUri(document.uri);

		if (!params) {
			return;
		}

		const fileChange = this.findMatchingFileNode(document.uri);
		const commentIndex = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);

		if (commentIndex < 0) {
			return;
		}

		if (comment.commentReactions && !comment.commentReactions.find(ret => ret.label === reaction.label && !!ret.hasReacted)) {
			// add reaction
			const matchedRawComment = (comment as (vscode.Comment & { _rawComment: IComment }))._rawComment;
			let result = await this._prManager.addCommentReaction(this.pullRequestModel, matchedRawComment.graphNodeId, reaction);
			let reactionGroups = result.addReaction.subject.reactionGroups;
			fileChange.comments[commentIndex].reactions = parseGraphQLReaction(reactionGroups);
			updateCommentReactions(comment, fileChange.comments[commentIndex].reactions!);
		} else {
			const matchedRawComment = (comment as (vscode.Comment & { _rawComment: IComment }))._rawComment;
			let result = await this._prManager.deleteCommentReaction(this.pullRequestModel, matchedRawComment.graphNodeId, reaction);
			let reactionGroups = result.removeReaction.subject.reactionGroups;
			fileChange.comments[commentIndex].reactions = parseGraphQLReaction(reactionGroups);
			updateCommentReactions(comment, fileChange.comments[commentIndex].reactions!);
		}

		if (this._prDocumentCommentProvider!.commentThreadCache[params.fileName]) {
			this._prDocumentCommentProvider!.commentThreadCache[params.fileName].forEach(thread => {
				if (!thread.comments) {
					return;
				}

				if (thread.comments.find((cmt: GHPRComment) => cmt.commentId === comment.commentId)) {
					thread.comments = thread.comments;
				}
			});
		}
	}

	// #endregion

	dispose(): void {
		super.dispose();

		if (this._inMemPRContentProvider) {
			this._inMemPRContentProvider.dispose();
		}

		if (this._prDocumentCommentProvider) {
			this._prDocumentCommentProvider.dispose();
		}

		this._commentController = undefined;

		this._disposables.forEach(d => d.dispose());
	}
}
