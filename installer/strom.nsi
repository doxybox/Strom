; Strøm – installasjonsprogram (NSIS 3, Modern UI 2)
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!define APPNAME "Strøm"
!define APPID "Strom"
!define VERSION "2.7.0"
!define PUBLISHER "Robin Salte / Salte Productions"
!define EXE "Strom.exe"
!define ELECTRON "44.10.2"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}"

Name "${APPNAME}"
Caption "${APPNAME} ${VERSION} – installasjon"
OutFile "Strom-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APPID}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
BrandingText "${APPNAME} ${VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=0 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=0 "FileDescription" "${APPNAME} – installasjon"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=0 "LegalCopyright" "© 2026 ${PUBLISHER}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

; ---- Utseende ----
!define MUI_ICON "strom.ico"
!define MUI_UNICON "strom.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "wizard.bmp"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Vil du avbryte installasjonen av ${APPNAME}?"
!define MUI_COMPONENTSPAGE_SMALLDESC

; ---- Sider ----
!define MUI_WELCOMEPAGE_TITLE "Velkommen til ${APPNAME}"
!define MUI_WELCOMEPAGE_TEXT "Denne veiviseren installerer ${APPNAME} ${VERSION} på datamaskinen din.$\r$\n$\r$\n${APPNAME} viser strømprisen akkurat nå, nettleien fra ditt nettselskap, hva strømmen koster time for time og – med en HAN-leser – forbruket ditt live.$\r$\n$\r$\nInstallasjonen trenger internett, fordi kjøremiljøet (ca. 150 MB) lastes ned underveis.$\r$\n$\r$\nTrykk Neste for å fortsette."
!insertmacro MUI_PAGE_WELCOME

!define MUI_LICENSEPAGE_TEXT_TOP "Les gjennom informasjonen under."
!define MUI_LICENSEPAGE_TEXT_BOTTOM "Trykk «Jeg godtar» for å fortsette."
!define MUI_LICENSEPAGE_BUTTON "&Jeg godtar"
!insertmacro MUI_PAGE_LICENSE "vilkar.txt"

!define MUI_PAGE_HEADER_TEXT "Velg innstillinger"
!define MUI_PAGE_HEADER_SUBTEXT "Velg hva som skal installeres sammen med ${APPNAME}."
!define MUI_COMPONENTSPAGE_TEXT_TOP "Kryss av for det du ønsker. ${APPNAME} legges alltid i Start-menyen."
!insertmacro MUI_PAGE_COMPONENTS

!define MUI_DIRECTORYPAGE_TEXT_TOP "${APPNAME} installeres i mappen under. Installasjonen krever ikke administratortilgang."
!insertmacro MUI_PAGE_DIRECTORY

!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "${APPNAME} er installert"
!define MUI_FINISHPAGE_TEXT "${APPNAME} er klar til bruk. Første gang velger du prisområde, nettselskap og strømavtale.$\r$\n$\r$\nDu finner ${APPNAME} i Start-menyen, og ved klokka nede til høyre mens programmet kjører. Nye versjoner installeres automatisk."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APPNAME} nå"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Norwegian"

; ---- Hjelpemakro: lukk programmet hvis det kjører ----
!macro CloseApp
  DetailPrint "Lukker ${APPNAME} hvis det kjører ..."
  nsExec::Exec 'taskkill /im "${EXE}" /f'
  Pop $0
  ; Test-versjonen (kjører som electron.exe fra en strom-mappe)
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '*strom*' } | Stop-Process -Force"`
  Pop $0
  Sleep 800
!macroend

; ---- Installasjon ----
Section "${APPNAME}" SecMain
  SectionIn RO
  !insertmacro CloseApp
  SetOutPath "$INSTDIR"

  ; Kjøremiljø (Electron) – lastes ned bare hvis riktig versjon mangler
  ${If} ${FileExists} "$INSTDIR\${EXE}"
  ${AndIf} ${FileExists} "$INSTDIR\electron-${ELECTRON}.ok"
    DetailPrint "Kjøremiljøet er allerede installert."
  ${Else}
    InitPluginsDir
    File "/oname=$PLUGINSDIR\hent-electron.ps1" "hent-electron.ps1"
    DetailPrint "Henter kjøremiljø fra github.com/electron ..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\hent-electron.ps1" -Dest "$INSTDIR"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "Klarte ikke å laste ned kjøremiljøet (kode $0).$\r$\n$\r$\nSjekk at du er koblet til internett og har minst 400 MB ledig plass, og prøv igjen."
      Abort "Installasjonen ble avbrutt."
    ${EndIf}
    Delete "$INSTDIR\${EXE}"
    Rename "$INSTDIR\electron.exe" "$INSTDIR\${EXE}"
    Delete "$INSTDIR\resources\default_app.asar"
    FileOpen $1 "$INSTDIR\electron-${ELECTRON}.ok" w
    FileWrite $1 "${ELECTRON}"
    FileClose $1
  ${EndIf}

  ; Ikon og navn på programfilen
  InitPluginsDir
  File "/oname=$PLUGINSDIR\rcedit.exe" "rcedit-x64.exe"
  File "/oname=$PLUGINSDIR\strom.ico" "strom.ico"
  DetailPrint "Setter ikon og navn ..."
  nsExec::Exec '"$PLUGINSDIR\rcedit.exe" "$INSTDIR\${EXE}" --set-icon "$PLUGINSDIR\strom.ico" --set-version-string "FileDescription" "${APPNAME}" --set-version-string "ProductName" "${APPNAME}" --set-version-string "CompanyName" "${PUBLISHER}" --set-version-string "OriginalFilename" "${EXE}" --set-file-version "${VERSION}" --set-product-version "${VERSION}"'
  Pop $0

  ; Programfilene
  RMDir /r "$INSTDIR\resources\app"
  SetOutPath "$INSTDIR\resources\app"
  File /r "payload\*.*"

  ; Snarvei i Start-menyen
  SetOutPath "$INSTDIR"
  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\resources\app\strom.ico" 0

  ; Avinstallering
  WriteUninstaller "$INSTDIR\Avinstaller.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\resources\app\strom.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Avinstaller.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Avinstaller.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Snarvei på skrivebordet" SecDesktop
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\resources\app\strom.ico" 0
SectionEnd

Section /o "Start ${APPNAME} når Windows starter" SecAutostart
  FileOpen $1 "$INSTDIR\resources\app\autostart.flag" w
  FileWrite $1 "1"
  FileClose $1
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "Selve programmet. Kjøremiljøet (ca. 150 MB) lastes ned under installasjonen."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Legger en ${APPNAME}-snarvei på skrivebordet."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAutostart} "${APPNAME} starter i bakgrunnen (ved klokka) når du logger på Windows. Kan endres i menyen senere."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---- Avinstallering ----
Section "Uninstall"
  !insertmacro CloseApp
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "no.robin.strom"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPNAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${APPNAME}"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\*.*"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  MessageBox MB_YESNO|MB_ICONQUESTION "Vil du også slette innstillingene og forbruksdataene dine?$\r$\n$\r$\nVelg Nei hvis du skal installere ${APPNAME} på nytt senere." /SD IDNO IDNO keep
    RMDir /r "$APPDATA\${APPID}"
    RMDir /r "$APPDATA\${APPNAME}"
  keep:
SectionEnd

Function .onInit
  ; Ikke kjør to installasjoner samtidig
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "StromSetupMutex") p .r1 ?e'
  Pop $R0
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Installasjonen av ${APPNAME} kjører allerede."
    Abort
  ${EndIf}
FunctionEnd


