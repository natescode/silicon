package com.natescode.silicon.lsp

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

/**
 * Application-level, persisted configuration for the Silicon language server.
 *
 * All fields may be left blank, in which case [SiliconServerLocator] auto-
 * detects the interpreter (bun, then node, on `PATH`) and the server script
 * (`lsp/src/index.ts`, searched upward from the project root).  Override here
 * when working outside the monorepo layout.
 */
@Service(Service.Level.APP)
@State(name = "SiliconLspSettings", storages = [Storage("silicon-lsp.xml")])
class SiliconLspSettings : PersistentStateComponent<SiliconLspSettings> {

    /** Enable/disable spawning the language server. */
    var enabled: Boolean = true

    /** Interpreter executable (e.g. `bun` or `node`).  Blank = auto-detect. */
    var interpreterPath: String = ""

    /** Path to the LSP entry script.  Blank = auto-detect under the project. */
    var serverScriptPath: String = ""

    override fun getState(): SiliconLspSettings = this
    override fun loadState(state: SiliconLspSettings) = XmlSerializerUtil.copyBean(state, this)

    companion object {
        fun getInstance(): SiliconLspSettings =
            ApplicationManager.getApplication().getService(SiliconLspSettings::class.java)
    }
}
