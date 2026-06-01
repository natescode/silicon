package com.natescode.silicon.lsp

import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import java.io.File

/**
 * Resolves the command used to launch the Silicon language server, honouring
 * [SiliconLspSettings] overrides and falling back to auto-detection so the
 * plugin works out of the box inside the Silicon monorepo.
 */
object SiliconServerLocator {

    private val LOG = logger<SiliconServerLocator>()

    /** A fully-resolved launch spec, or `null` if no server could be located. */
    data class Command(val interpreter: String, val script: String, val workDir: String)

    fun resolve(project: Project): Command? {
        val settings = SiliconLspSettings.getInstance()

        val script = settings.serverScriptPath.ifBlank { findServerScript(project) }
        if (script.isNullOrBlank() || !File(script).isFile) {
            LOG.warn("Silicon LSP script not found (configured='${settings.serverScriptPath}'); " +
                "set it in Settings | Languages & Frameworks | Silicon.")
            return null
        }

        val interpreter = settings.interpreterPath.ifBlank { detectInterpreter() }
        if (interpreter.isNullOrBlank()) {
            LOG.warn("No bun/node interpreter found on PATH for the Silicon LSP.")
            return null
        }

        // Run from the monorepo root (two levels up from lsp/src) so the
        // server's workspace + @silicon/compiler resolution behaves as in dev.
        val workDir = File(script).parentFile?.parentFile?.parentFile?.absolutePath
            ?: project.basePath ?: File(script).parent
        return Command(interpreter, script, workDir)
    }

    /** Prefer `bun`; fall back to `node`. */
    private fun detectInterpreter(): String? =
        findOnPath("bun") ?: findOnPath("node")

    private fun findOnPath(exe: String): String? =
        PathEnvironmentVariableUtil.findExecutableInPathOnAnyOS(exe)?.absolutePath

    /** Walk up from the project root looking for `lsp/src/index.ts`. */
    private fun findServerScript(project: Project): String? {
        var dir: File? = project.basePath?.let(::File)
        repeat(8) {
            val d = dir ?: return null
            val candidate = File(d, "lsp/src/index.ts")
            if (candidate.isFile) return candidate.absolutePath
            dir = d.parentFile
        }
        return null
    }
}
