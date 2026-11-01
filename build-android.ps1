$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
& (Join-Path $root 'gradlew.bat') clean :app:assembleDebug
if ($LASTEXITCODE -ne 0) { throw 'Android debug build failed' }
Write-Host "APK: $(Join-Path $root 'app\build\outputs\apk\debug\app-debug.apk')"
