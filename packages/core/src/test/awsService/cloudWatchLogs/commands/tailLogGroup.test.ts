/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as sinon from 'sinon'
import * as FakeTimers from '@sinonjs/fake-timers'
import * as vscode from 'vscode'

import assert from 'assert'
import { clearDocument, closeSession, tailLogGroup } from '../../../../awsService/cloudWatchLogs/commands/tailLogGroup'
import { LiveTailSessionLogEvent, StartLiveTailResponseStream } from '@aws-sdk/client-cloudwatch-logs'
import { LiveTailSessionRegistry } from '../../../../awsService/cloudWatchLogs/registry/liveTailSessionRegistry'
import { LiveTailSession } from '../../../../awsService/cloudWatchLogs/registry/liveTailSession'
import { asyncGenerator } from '../../../../shared/utilities/collectionUtils'
import {
    TailLogGroupWizard,
    TailLogGroupWizardResponse,
} from '../../../../awsService/cloudWatchLogs/wizard/tailLogGroupWizard'
import { getTestWindow } from '../../../shared/vscode/window'
import { CloudWatchLogsSettings, uriToKey } from '../../../../awsService/cloudWatchLogs/cloudWatchLogsUtils'
import { installFakeClock } from '../../../testUtil'
import { DefaultAwsContext, ToolkitError } from '../../../../shared'
import { LiveTailCodeLensProvider } from '../../../../awsService/cloudWatchLogs/document/liveTailCodeLensProvider'

describe('TailLogGroup', function () {
    const testLogGroup = 'test-log-group'
    const testRegion = 'test-region'
    const testMessage = 'test-message'
    const testAwsAccountId = '1234'
    const testSource = 'test-source'
    const testAwsCredentials = {} as any as AWS.Credentials

    let sandbox: sinon.SinonSandbox
    let registry: LiveTailSessionRegistry
    let codeLensProvider: LiveTailCodeLensProvider
    let startLiveTailSessionSpy: sinon.SinonSpy
    let stopLiveTailSessionSpy: sinon.SinonSpy
    let cloudwatchSettingsSpy: sinon.SinonSpy
    let wizardSpy: sinon.SinonSpy

    let clock: FakeTimers.InstalledClock

    before(function () {
        clock = installFakeClock()
    })

    beforeEach(function () {
        clock.reset()
        sandbox = sinon.createSandbox()
        registry = new LiveTailSessionRegistry()
        codeLensProvider = new LiveTailCodeLensProvider(registry)
    })

    after(function () {
        clock.uninstall()
    })

    afterEach(function () {
        sandbox.restore()
    })

    it('starts LiveTailSession and writes to document. Closes tab and asserts session gets closed.', async function () {
        sandbox.stub(DefaultAwsContext.prototype, 'getCredentialAccountId').returns(testAwsAccountId)
        sandbox.stub(DefaultAwsContext.prototype, 'getCredentials').returns(Promise.resolve(testAwsCredentials))

        wizardSpy = sandbox.stub(TailLogGroupWizard.prototype, 'run').callsFake(async function () {
            return getTestWizardResponse()
        })
        const testMessage2 = `${testMessage}-2`
        const testMessage3 = `${testMessage}-3`
        startLiveTailSessionSpy = sandbox
            .stub(LiveTailSession.prototype, 'startLiveTailSession')
            .callsFake(async function () {
                return getTestResponseStream([
                    {
                        message: testMessage,
                        timestamp: 876830400000,
                    },
                    {
                        message: testMessage2,
                        timestamp: 876830402000,
                    },
                    {
                        message: testMessage3,
                        timestamp: 876830403000,
                    },
                ])
            })
        stopLiveTailSessionSpy = sandbox
            .stub(LiveTailSession.prototype, 'stopLiveTailSession')
            .callsFake(async function () {
                return
            })

        //Set maxLines to 1.
        cloudwatchSettingsSpy = sandbox.stub(CloudWatchLogsSettings.prototype, 'get').callsFake(() => {
            return 1
        })
        await tailLogGroup(registry, testSource, codeLensProvider, {
            groupName: testLogGroup,
            regionName: testRegion,
        })
        assert.strictEqual(wizardSpy.calledOnce, true)
        assert.strictEqual(cloudwatchSettingsSpy.calledOnce, true)
        assert.strictEqual(startLiveTailSessionSpy.calledOnce, true)
        assert.strictEqual(registry.size, 1)

        //registry is asserted to have only one entry, so this is assumed to be the session that was
        //started in this test.
        let sessionUri: vscode.Uri | undefined
        registry.forEach((session) => (sessionUri = session.uri))
        if (sessionUri === undefined) {
            throw Error
        }
        const document = getTestWindow().activeTextEditor?.document
        assert.strictEqual(sessionUri.toString(), document?.uri.toString())
        //Test responseStream has 3 events, maxLines is set to 1. Only 3rd event should be in doc.
        assert.strictEqual(document?.getText().trim(), `12:00:03\t${testMessage3}`)

        //Test that closing all tabs the session's document is open in will cause the session to close
        const window = getTestWindow()
        let tabs: vscode.Tab[] = []
        window.tabGroups.all.forEach((tabGroup) => {
            tabs = tabs.concat(getLiveTailSessionTabsFromTabGroup(tabGroup, sessionUri!))
        })
        await Promise.all(tabs.map((tab) => window.tabGroups.close(tab)))
        assert.strictEqual(registry.size, 0)
        assert.strictEqual(stopLiveTailSessionSpy.calledOnce, true)
    })

    it('throws if crendentials are undefined', async function () {
        sandbox.stub(DefaultAwsContext.prototype, 'getCredentials').returns(Promise.resolve(undefined))
        wizardSpy = sandbox.stub(TailLogGroupWizard.prototype, 'run').callsFake(async function () {
            return getTestWizardResponse()
        })
        await assert.rejects(async () => {
            await tailLogGroup(registry, testSource, codeLensProvider, {
                groupName: testLogGroup,
                regionName: testRegion,
            })
        }, ToolkitError)
    })

    it('closeSession removes session from registry and calls underlying stopLiveTailSession function.', function () {
        stopLiveTailSessionSpy = sandbox
            .stub(LiveTailSession.prototype, 'stopLiveTailSession')
            .callsFake(async function () {
                return
            })

        const session = new LiveTailSession({
            logGroupArn: testLogGroup,
            region: testRegion,
            awsCredentials: testAwsCredentials,
        })
        registry.set(uriToKey(session.uri), session)

        closeSession(session.uri, registry, testSource, codeLensProvider)
        assert.strictEqual(0, registry.size)
        assert.strictEqual(true, stopLiveTailSessionSpy.calledOnce)
        assert.strictEqual(0, clock.countTimers())
    })

    it('clearDocument clears all text from document', async function () {
        const session = new LiveTailSession({
            logGroupArn: testLogGroup,
            region: testRegion,
            awsCredentials: testAwsCredentials,
        })
        const testData = 'blah blah blah'
        const document = await vscode.workspace.openTextDocument(session.uri)
        const edit = new vscode.WorkspaceEdit()
        edit.insert(document.uri, new vscode.Position(0, 0), testData)
        await vscode.workspace.applyEdit(edit)
        assert.strictEqual(document.getText(), testData)

        await clearDocument(document)
        assert.strictEqual(document.getText(), '')
    })

    function getLiveTailSessionTabsFromTabGroup(tabGroup: vscode.TabGroup, sessionUri: vscode.Uri): vscode.Tab[] {
        return tabGroup.tabs.filter((tab) => {
            if (tab.input instanceof vscode.TabInputText) {
                return sessionUri!.toString() === tab.input.uri.toString()
            }
        })
    }

    function getTestWizardResponse(): TailLogGroupWizardResponse {
        return {
            regionLogGroupSubmenuResponse: {
                region: testRegion,
                data: testLogGroup,
            },
            filterPattern: '',
            logStreamFilter: {
                type: 'all',
            },
        }
    }

    //Creates a test response stream. Each log event provided will be its own "frame" of the input stream.
    function getTestResponseStream(logEvents: LiveTailSessionLogEvent[]): AsyncIterable<StartLiveTailResponseStream> {
        const sessionStartFrame: StartLiveTailResponseStream = {
            sessionStart: {
                logGroupIdentifiers: [testLogGroup],
            },
            sessionUpdate: undefined,
        }

        const updateFrames: StartLiveTailResponseStream[] = logEvents.map((event) => {
            return {
                sessionUpdate: {
                    sessionMetadata: {
                        sampled: false,
                    },
                    sessionResults: [event],
                },
            }
        })

        return asyncGenerator([sessionStartFrame, ...updateFrames])
    }
})