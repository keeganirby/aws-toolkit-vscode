import * as vscode from 'vscode'

export class LiveTailDocumentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
        //Content will be written to the document via handling a response stream only via the tailLogGroup command.
        return ''
    }
}
