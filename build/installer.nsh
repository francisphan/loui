; Registers Loui as a web browser for the current user, so that Windows lists
; it in Settings > Default apps (see src/main/default-browser.js). Included in
; the installer by electron-builder ("nsis.include" in package.json). The
; installer is per-user, so everything goes under HKCU.
;
; Windows starts Loui with `-- "<link>"`: the `--` ends Chromium's switches, so
; a link that starts with dashes cannot be taken for one.

!macro customInstall
  ; What opens links and pages: a ProgID of Loui's own.
  WriteRegStr HKCU "Software\Classes\LouiHTML" "" "Loui HTML Document"
  WriteRegStr HKCU "Software\Classes\LouiHTML\Application" "ApplicationName" "Loui"
  WriteRegStr HKCU "Software\Classes\LouiHTML\Application" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\LouiHTML\Application" "ApplicationCompany" "Loui"
  WriteRegStr HKCU "Software\Classes\LouiHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\LouiHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'

  ; Loui as a browser, and what it can open.
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui" "" "Loui"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\Capabilities" "ApplicationName" "Loui"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\Capabilities" "ApplicationDescription" "A web browser Claude drives alongside you"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\Capabilities\StartMenu" "StartMenuInternet" "Loui"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\Capabilities\URLAssociations" "http" "LouiHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\Capabilities\URLAssociations" "https" "LouiHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\Capabilities\FileAssociations" ".htm" "LouiHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Loui\Capabilities\FileAssociations" ".html" "LouiHTML"

  ; The name Settings knows Loui by (ms-settings:defaultapps?registeredAppUser=Loui).
  WriteRegStr HKCU "Software\RegisteredApplications" "Loui" "Software\Clients\StartMenuInternet\Loui\Capabilities"

  ; Tell Explorer that associations changed (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the entries stay, so the choice
  ; of default browser survives it.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\LouiHTML"
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Loui"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Loui"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
