package com.natescode.silicon.lsp

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.server.OSProcessStreamConnectionProvider

/**
 * Launches the Silicon language server (`silicon-lsp --stdio`) as a child
 * process and bridges its stdio to LSP4IJ.  The command is resolved per
 * project from [SiliconServerLocator]; if unresolved, the command line is left
 * empty and LSP4IJ reports the start failure in its console.
 */
class SiliconStreamConnectionProvider(project: Project) : OSProcessStreamConnectionProvider() {

    init {
        SiliconServerLocator.resolve(project)?.let { cmd ->
            commandLine = GeneralCommandLine(cmd.interpreter, cmd.script, "--stdio").apply {
                withWorkDirectory(cmd.workDir)
                withCharset(Charsets.UTF_8)
                withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
            }
        }
    }
}
