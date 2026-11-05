$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
try {
    $taskPython = $null
    $taskPrefix = @()
    $taskVenv = Join-Path $taskRoot '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $taskVenv) {
        $taskPython = $taskVenv
    } elseif (Get-Command py.exe -ErrorAction SilentlyContinue) {
        $taskPython = (Get-Command py.exe).Source
        $taskPrefix = @('-3')
    } elseif (Get-Command python.exe -ErrorAction SilentlyContinue) {
        $taskPython = (Get-Command python.exe).Source
    } else {
        throw 'Python 3.12 or newer is required. See README.md, or use the Windows release ZIP.'
    }
    # Choose a free port so another working copy cannot capture this launch.
    Start-Process -FilePath $taskPython -ArgumentList ($taskPrefix + @('server.py','--port','0','--open')) -WorkingDirectory $taskRoot -WindowStyle Hidden
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'Photogrammetry Lab') | Out-Null
}
