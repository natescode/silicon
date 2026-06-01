package com.natescode.silicon

import com.intellij.lang.Commenter

/** Enables Ctrl+/ line-comment toggling.  Silicon has only `#` line comments. */
class SiliconCommenter : Commenter {
    override fun getLineCommentPrefix(): String = "# "
    override fun getBlockCommentPrefix(): String? = null
    override fun getBlockCommentSuffix(): String? = null
    override fun getCommentedBlockCommentPrefix(): String? = null
    override fun getCommentedBlockCommentSuffix(): String? = null
}
