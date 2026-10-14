# Disposable WinForms window for the Windows CUA end-to-end test. It records
# what reached it (text, key chords, button clicks) in fixture-state.json.
param([Parameter(Mandatory = $true)][string]$Root)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$state = [ordered]@{ pid = $PID; value = ""; clicks = 0; chords = 0; ready = $false }
$statePath = Join-Path $Root "fixture-state.json"

function Save-State {
  $temporary = "$statePath.tmp"
  # WriteAllText writes UTF-8 without a byte-order mark, which JSON parsers
  # reject; Windows PowerShell's Set-Content -Encoding UTF8 would add one.
  [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress))
  Move-Item -Force -Path $temporary -Destination $statePath
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Opengeni CUA Fixture"
$form.ClientSize = New-Object System.Drawing.Size(640, 400)
$form.StartPosition = "CenterScreen"

$text = New-Object System.Windows.Forms.TextBox
$text.Dock = "Top"
$text.AccessibleName = "Fixture text"
$text.Font = New-Object System.Drawing.Font("Segoe UI", 14)
$text.Add_TextChanged({ $state.value = $text.Text; Save-State })
$text.Add_KeyDown({
  param($sender, $event)
  if ($event.Control -and $event.Shift -and $event.KeyCode -eq "K") { $state.chords++; Save-State }
})

# The button fills the lower part of the window so a pixel click is unambiguous.
$button = New-Object System.Windows.Forms.Button
$button.Text = "Increment"
$button.Dock = "Bottom"
$button.Height = 240
$button.Add_Click({ $state.clicks++; Save-State })

$form.Controls.Add($button)
$form.Controls.Add($text)
$form.ActiveControl = $text
$form.Add_Shown({ $state.ready = $true; Save-State; $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
