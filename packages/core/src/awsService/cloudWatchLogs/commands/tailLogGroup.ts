/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { convertToTimeString, globals } from '../../../shared'
import { CancellationError } from '../../../shared/utilities/timeoutUtils'
import { LiveTailSessionLogEvent, StartLiveTailCommandOutput } from '@aws-sdk/client-cloudwatch-logs'
import { LiveTailSessionRegistry } from '../registry/liveTailSessionRegistry'
import { LiveTailSession, LiveTailSessionConfiguration } from '../registry/liveTailSession'
import { TailLogGroupWizard } from '../wizard/tailLogGroupWizard'

export async function tailLogGroup(
    registry: LiveTailSessionRegistry,
    logData?: { regionName: string; groupName: string }
): Promise<void> {
    const wizard = new TailLogGroupWizard(logData)
    const wizardResponse = await wizard.run()
    if (!wizardResponse) {
        throw new CancellationError('user')
    }

    const liveTailSessionConfig: LiveTailSessionConfiguration = {
        logGroupName: wizardResponse.regionLogGroupSubmenuResponse.data,
        logStreamFilter: wizardResponse.logStreamFilter,
        logEventFilterPattern: wizardResponse.filterPattern,
        region: wizardResponse.regionLogGroupSubmenuResponse.region,
    }

    const liveTailSession = new LiveTailSession(liveTailSessionConfig)
    if (registry.doesRegistryContainLiveTailSession(liveTailSession.uri)) {
        await prepareDocument(liveTailSession)
        return
    }
    registry.registerLiveTailSession(liveTailSession)

    const textDocument = await prepareDocument(liveTailSession)

    const timer = startTimer(liveTailSession)
    hideShowStatusBarItemsOnActiveEditor(liveTailSession, textDocument)

    registerTabChangeCallback(liveTailSession, timer, registry, textDocument)

    const liveTailResponseStream = await liveTailSession.startLiveTailSession()
    displayTailingSessionDialogueWindow(liveTailSession, timer, registry)

    await handleLiveTailResponse(liveTailResponseStream, textDocument, liveTailSession)
}

export async function closeSession(sessionUri: vscode.Uri, registry: LiveTailSessionRegistry) {
    const session = registry.getLiveTailSessionFromUri(sessionUri)
    session.stopLiveTailSession()
    registry.removeLiveTailSessionFromRegistry(sessionUri)
}

function hideShowStatusBarItemsOnActiveEditor(session: LiveTailSession, textDocument: vscode.TextDocument) {
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document == textDocument) {
            session.statusBarItems.eventRate.show()
            session.statusBarItems.isSampled.show()
            session.statusBarItems.sessionTimer.show()
        } else {
            session.statusBarItems.eventRate.hide()
            session.statusBarItems.isSampled.hide()
            session.statusBarItems.sessionTimer.hide()
        }
    })
}

async function displayTailingSessionDialogueWindow(
    session: LiveTailSession,
    timer: NodeJS.Timer,
    registry: LiveTailSessionRegistry
) {
    let message = `Tailing Log Group: '${session.logGroupName}.'`
    const stopTailing = 'Stop Tailing'
    const item = await vscode.window.showInformationMessage(message, stopTailing)
    try {
        if (item && item === stopTailing) {
            closeSession(session.uri, registry)
            globals.clock.clearInterval(timer)
        }
    } catch (e) {
        console.log('[EXCEPTION]', e)
    }
}

async function prepareDocument(session: LiveTailSession): Promise<vscode.TextDocument> {
    const textDocument = await vscode.workspace.openTextDocument(session.uri)
    clearDocument(textDocument)
    await vscode.window.showTextDocument(textDocument, { preview: false })
    showLiveTailSessionStatusBarItems(session)
    vscode.languages.setTextDocumentLanguage(textDocument, 'log')
    return textDocument
}

function showLiveTailSessionStatusBarItems(session: LiveTailSession) {
    session.statusBarItems.eventRate.show()
    session.statusBarItems.isSampled.show()
    session.statusBarItems.sessionTimer.show()
}

async function handleLiveTailResponse(
    response: StartLiveTailCommandOutput,
    textDocument: vscode.TextDocument,
    session: LiveTailSession
) {
    if (!response.responseStream) {
        throw Error('response is undefined')
    }

    try {
        for await (const event of response.responseStream) {
            if (event.sessionStart !== undefined) {
                console.log(event.sessionStart)
            } else if (event.sessionUpdate !== undefined) {
                console.log('Got new log events.')
                const formattedLogEvents = event.sessionUpdate.sessionResults!.map<string>((logEvent) =>
                    formatLogEvent(logEvent)
                )

                if (formattedLogEvents.length !== 0) {
                    //Determine should scroll before adding new lines to doc because large amount of
                    //new lines can push bottom of file out of view before scrolling.
                    const editorsToScroll = getTextEditorsToScroll(textDocument)
                    await updateTextDocumentWithNewLogEvents(formattedLogEvents, textDocument, session.maxLines)
                    editorsToScroll.forEach(scrollTextEditorToBottom)
                }
                updateIsSampledStatusBar(
                    event.sessionUpdate.sessionMetadata?.sampled!,
                    session.statusBarItems.isSampled
                )
                updateEventRateStatusBar(event.sessionUpdate.sessionResults?.length!, session.statusBarItems.eventRate)
            } else {
                console.error('Unknown event type')
            }
        }
    } catch (err) {
        console.warn('Caught on-stream exception: ' + err)
    }
}

async function updateTextDocumentWithNewLogEvents(
    formattedLogEvents: string[],
    textDocument: vscode.TextDocument,
    maxLines: number
) {
    const edit = new vscode.WorkspaceEdit()
    formattedLogEvents.forEach((formattedLogEvent) =>
        edit.insert(textDocument.uri, new vscode.Position(textDocument.lineCount, 0), formattedLogEvent)
    )
    if (textDocument.lineCount + formattedLogEvents.length > maxLines) {
        trimOldestLines(formattedLogEvents.length, textDocument, edit, maxLines)
    }
    await vscode.workspace.applyEdit(edit)
}

//TODO: Trimming lines seems to jitter the screen. Can we keep the lines the customer has in view, fixed in place?
//Scroll up num lines deleted?
function trimOldestLines(
    numNewLines: number,
    textDocument: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    maxLines: number
) {
    const numLinesToTrim = textDocument.lineCount + numNewLines - maxLines
    const startPosition = new vscode.Position(0, 0)
    const endPosition = new vscode.Position(numLinesToTrim, 0)

    const range = new vscode.Range(startPosition, endPosition)
    edit.delete(textDocument.uri, range)
}

function formatLogEvent(logEvent: LiveTailSessionLogEvent): string {
    if (!logEvent.timestamp || !logEvent.message) {
        return ''
    }
    const timestamp = new Date(logEvent.timestamp).toLocaleTimeString('en', {
        timeStyle: 'medium',
        hour12: false,
        timeZone: 'UTC',
    })
    let line = timestamp.concat('\t', logEvent.message)
    if (!line.endsWith('\n')) {
        line = line.concat('\n')
    }
    return line
}

function getTextEditorsToScroll(textDocument: vscode.TextDocument): vscode.TextEditor[] {
    const visibleEditorsForSession = getVisibleEditorsForSession(textDocument)
    return visibleEditorsForSession.filter((editor) => shouldScrollTextEditor(textDocument, editor))
}

function getVisibleEditorsForSession(textDocument: vscode.TextDocument): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((editor) => editor.document === textDocument)
}

function shouldScrollTextEditor(textDocument: vscode.TextDocument, textEditor: vscode.TextEditor): boolean {
    const lineCount = textDocument.lineCount
    const lastLinePos = new vscode.Position(lineCount - 1, 0)
    const visibleRange = textEditor.visibleRanges[0]
    if (visibleRange.contains(lastLinePos)) {
        return true
    }
    return false
}

function scrollTextEditorToBottom(textEditor: vscode.TextEditor) {
    const topPosition = new vscode.Position(Math.max(textEditor.document.lineCount - 2, 0), 0)
    const bottomPosition = new vscode.Position(Math.max(textEditor.document.lineCount - 2, 0), 0)

    textEditor.revealRange(new vscode.Range(topPosition, bottomPosition), vscode.TextEditorRevealType.Default)
}

export async function clearDocument(textDocument: vscode.TextDocument) {
    const edit = new vscode.WorkspaceEdit()
    const startPosition = new vscode.Position(0, 0)
    const endPosition = new vscode.Position(textDocument.lineCount, 0)
    edit.delete(textDocument.uri, new vscode.Range(startPosition, endPosition))
    await vscode.workspace.applyEdit(edit)
}

function updateIsSampledStatusBar(isSampled: boolean, isSampledStatusBarItem: vscode.StatusBarItem) {
    const text = `Sampled: ${isSampled ? 'Yes' : 'No'}`
    isSampledStatusBarItem.text = text
    return isSampledStatusBarItem
}

function updateEventRateStatusBar(numEvents: number, eventRateStatusBarItem: vscode.StatusBarItem) {
    const text = `${numEvents} events/sec.`
    eventRateStatusBarItem.text = text
    return eventRateStatusBarItem
}

function registerTabChangeCallback(
    liveTailSession: LiveTailSession,
    timer: NodeJS.Timer,
    registry: LiveTailSessionRegistry,
    textDocument: vscode.TextDocument
) {
    //onDidChangeTabs triggers when tabs are created, closed, or swapped focus
    vscode.window.tabGroups.onDidChangeTabs((tabEvent) => {
        const isOpen = isLiveTailSessionOpenInAnyTab(liveTailSession)
        if (!isOpen) {
            closeSession(liveTailSession.uri, registry)
            globals.clock.clearInterval(timer)
            clearDocument(textDocument)
        }
    })
}

function isLiveTailSessionOpenInAnyTab(liveTailSession: LiveTailSession) {
    var isOpen = false
    vscode.window.tabGroups.all.forEach((tabGroup) => {
        tabGroup.tabs.forEach((tab) => {
            if (tab.input instanceof vscode.TabInputText) {
                if (liveTailSession.uri.toString() === tab.input.uri.toString()) {
                    isOpen = true
                }
            }
        })
    })
    return isOpen
}

function startTimer(liveTailSession: LiveTailSession): NodeJS.Timer {
    return globals.clock.setInterval(() => {
        const elapsedTime = liveTailSession.getLiveTailSessionDuration()
        const timeString = convertToTimeString(elapsedTime)
        liveTailSession.statusBarItems.sessionTimer.text = `LiveTail Session Timer: ${timeString}`
    }, 500)
}
