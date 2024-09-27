import * as vscode from 'vscode'
import { CLOUDWATCH_LOGS_LT_SCHEME } from '../../../shared/constants'

export class LiveTailCodeLensProvider implements vscode.CodeLensProvider {
    onDidChangeCodeLenses?: vscode.Event<void> | undefined

    provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CodeLens[]> {
        const uri = document.uri
        if (uri.scheme !== CLOUDWATCH_LOGS_LT_SCHEME) {
            return []
        }
        const codeLenses: vscode.CodeLens[] = []
        codeLenses.push(this.buildClearDocumentCodeLens(document))
        return codeLenses
    }

    private buildClearDocumentCodeLens(document: vscode.TextDocument): vscode.CodeLens {
        const range = new vscode.Range(
            new vscode.Position(document.lineCount - 1, 0),
            new vscode.Position(document.lineCount - 1, 0)
        )
        const command: vscode.Command = {
            title: 'Clear document',
            command: 'aws.cwl.clearDocument',
            arguments: [document],
        }
        return new vscode.CodeLens(range, command)
    }
}
