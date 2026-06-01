plugins {
    kotlin("jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "com.natescode.silicon"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
        // Java compiler + instrumentation artifacts (used by :instrumentCode).
        intellijDependencies()
        // LSP4IJ is published to the JetBrains Marketplace; the
        // intellijPlatform repositories include it automatically.
    }
}

dependencies {
    intellijPlatform {
        // Target IntelliJ IDEA Community 2024.2.  Works in Community and
        // Ultimate; LSP4IJ supplies the LSP runtime so we don't depend on
        // the Ultimate-only com.intellij.platform.lsp module.
        intellijIdeaCommunity("2024.2.4")

        // LSP4IJ — the open-source Language Server Protocol client for the
        // IntelliJ Platform (Red Hat).  Pulls the LSP runtime into the IDE.
        plugin("com.redhat.devtools.lsp4ij", "0.7.0")

        pluginVerifier()
        zipSigner()
        instrumentationTools()
    }

    // The lexer tests are plain JUnit 5 unit tests — they drive SiliconLexer
    // directly and do not boot an IDE, so the IntelliJ platform test framework
    // (and its JUnit 4 launcher listener) is intentionally not on the classpath.
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

intellijPlatform {
    pluginConfiguration {
        id = "com.natescode.silicon"
        name = "Silicon"
        version = project.version.toString()

        description =
            """
            Language support for the <b>Silicon</b> programming language
            (<code>.si</code>): syntax highlighting and a Language Server
            (diagnostics, go-to-definition, document symbols, hover) powered
            by the Silicon LSP and LSP4IJ.
            """.trimIndent()

        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null }
        }

        vendor {
            name = "natescode"
            email = "nate@natescode.com"
            url = "https://github.com/natescode/silicon"
        }
    }

    pluginVerification {
        ides {
            recommended()
        }
    }
}

kotlin {
    jvmToolchain(21)
}

tasks {
    test {
        useJUnitPlatform()
    }
}
