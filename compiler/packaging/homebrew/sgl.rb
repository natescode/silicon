class Sgl < Formula
  desc "The Silicon compiler — WebAssembly-targeting language with a Roslyn-style library API"
  homepage "https://github.com/natescode/sigil"
  version "1.0.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/natescode/sigil/releases/download/v#{version}/sgl-v#{version}-macos-aarch64.tar.gz"
      sha256 "PLACEHOLDER_MACOS_AARCH64_SHA256"
    end
    on_intel do
      url "https://github.com/natescode/sigil/releases/download/v#{version}/sgl-v#{version}-macos-x86_64.tar.gz"
      sha256 "PLACEHOLDER_MACOS_X86_64_SHA256"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/natescode/sigil/releases/download/v#{version}/sgl-v#{version}-linux-aarch64.tar.gz"
      sha256 "PLACEHOLDER_LINUX_AARCH64_SHA256"
    end
    on_intel do
      url "https://github.com/natescode/sigil/releases/download/v#{version}/sgl-v#{version}-linux-x86_64.tar.gz"
      sha256 "PLACEHOLDER_LINUX_X86_64_SHA256"
    end
  end

  def install
    bin.install "sgl"
  end

  test do
    (testpath/"hello.si").write('@fn main:Int := 0;')
    system bin/"sgl", "check", "hello.si"
  end
end
