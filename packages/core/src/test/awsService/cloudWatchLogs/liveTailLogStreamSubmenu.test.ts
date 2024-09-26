import assert from 'assert'
import { LogStreamFilterSubmenu } from '../../../awsService/cloudWatchLogs/liveTailLogStreamSubmenu'
import { createQuickPickPrompterTester, QuickPickPrompterTester } from '../../shared/ui/testUtils'
import { getTestWindow } from '../../shared/vscode/window'

describe('liveTailLogStreamSubmenu', async function () {
    let logStreamFilterSubmenu: LogStreamFilterSubmenu
    let logStreamMenuPrompter: QuickPickPrompterTester<any>
    const testRegion = 'us-east-1'
    const testLogGroupArn = 'my-log-group-arn'

    beforeEach(async function () {
        logStreamFilterSubmenu = new LogStreamFilterSubmenu(testRegion, testLogGroupArn)
        logStreamMenuPrompter = createQuickPickPrompterTester(logStreamFilterSubmenu.defaultPrompter)
    })

    describe('Menu prompter', async function () {
        it('gives option for each filter type', async function () {
            logStreamMenuPrompter.assertContainsItems('All', 'Specific', 'Prefix')
            logStreamMenuPrompter.acceptItem('All')
            await logStreamMenuPrompter.result()
        })
    })

    describe('LogStream Prefix Submenu', function () {
        it('accepts valid input', async function () {
            const validInput = 'my-log-stream'
            getTestWindow().onDidShowInputBox((input) => {
                input.acceptValue(validInput)
            })
            const inputBox = logStreamFilterSubmenu.createLogStreamPrefixBox()
            const result = inputBox.prompt()
            assert.strictEqual(await result, validInput)
        })

        it('rejects invalid input (:)', async function () {
            const invalidInput = 'my-log-stream:'
            getTestWindow().onDidShowInputBox((input) => {
                input.acceptValue(invalidInput)
                assert.deepEqual(input.validationMessage, 'LogStream prefix must match pattern: [^:*]*')
                input.hide()
            })
            const inputBox = logStreamFilterSubmenu.createLogStreamPrefixBox()
            await inputBox.prompt()
        })

        it('rejects invalid input (*)', async function () {
            const invalidInput = 'my-log-stream*'
            getTestWindow().onDidShowInputBox((input) => {
                input.acceptValue(invalidInput)
                assert.deepEqual(input.validationMessage, 'LogStream prefix must match pattern: [^:*]*')
                input.hide()
            })
            const inputBox = logStreamFilterSubmenu.createLogStreamPrefixBox()
            await inputBox.prompt()
        })

        it('rejects invalid input (length)', async function () {
            const invalidInput = 'a'.repeat(520)
            getTestWindow().onDidShowInputBox((input) => {
                input.acceptValue(invalidInput)
                assert.deepEqual(input.validationMessage, 'LogStream prefix cannot be longer than 512 characters')
                input.hide()
            })
            const inputBox = logStreamFilterSubmenu.createLogStreamPrefixBox()
            await inputBox.prompt()
        })
    })
})