package com.natescode.silicon.lsp

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel

/**
 * *Settings | Languages & Frameworks | Silicon* — configures how the language
 * server is launched.  Bound to the application-level [SiliconLspSettings].
 */
class SiliconLspConfigurable : BoundConfigurable("Silicon") {

    private val settings = SiliconLspSettings.getInstance()

    override fun createPanel(): DialogPanel = panel {
        row {
            checkBox("Enable Silicon language server")
                .bindSelected(settings::enabled)
        }
        row("Interpreter:") {
            textField()
                .bindText(settings::interpreterPath)
                .align(AlignX.FILL)
                .comment("Path to <code>bun</code> or <code>node</code>. Leave blank to auto-detect on PATH.")
        }
        row("Server script:") {
            textField()
                .bindText(settings::serverScriptPath)
                .align(AlignX.FILL)
                .comment("Path to the LSP entry (e.g. <code>lsp/src/index.ts</code>). " +
                    "Leave blank to auto-detect under the project root.")
        }
        row {
            comment("Changes apply to newly started servers. " +
                "Restart via the <b>Language Servers</b> tool window after editing.")
        }
    }
}
