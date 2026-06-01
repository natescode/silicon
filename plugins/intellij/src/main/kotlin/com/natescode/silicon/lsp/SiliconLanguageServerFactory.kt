package com.natescode.silicon.lsp

import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider

/**
 * LSP4IJ factory wiring the Silicon language server.  Referenced from
 * `plugin.xml` via the `com.redhat.devtools.lsp4ij.server` extension point and
 * bound to the Silicon language through `languageMapping`.
 */
class SiliconLanguageServerFactory : LanguageServerFactory {
    override fun createConnectionProvider(project: Project): StreamConnectionProvider =
        SiliconStreamConnectionProvider(project)
}
