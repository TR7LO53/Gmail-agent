# Ggent — jedzenie (Android)

Minimalny szkielet aplikacji mobilnej: Svelte, Vite, TypeScript i Capacitor. Plugin SQLite jest zarejestrowany w projekcie Androida; aplikacja nie otwiera jeszcze bazy.

## Wymagania

- Node.js 22 lub nowszy (zainstalowany Capacitor CLI wymaga Node 22 lub nowszego).
- Android Studio z Android SDK wymaganym przez wygenerowany projekt.
- JDK 21. W Android Studio wybierz JDK dołączony do instalacji (Android Studio > Settings > Build, Execution, Deployment > Build Tools > Gradle > Gradle JDK).

## Test i build webowy

Z katalogu repozytorium uruchom PowerShell i ustaw ścieżki do checkoutu:

```powershell
$repoRoot = 'C:\ścieżka\do\checkoutu'
$appRoot = Join-Path $repoRoot 'android-app'
$androidRoot = Join-Path $appRoot 'android'
npm --prefix "$appRoot" ci
npm --prefix "$appRoot" run test
npm --prefix "$appRoot" run build
npm --prefix "$appRoot" run cap:sync
```

`build` sprawdza typy i komponenty Svelte, a następnie tworzy `dist/`. `cap:sync` kopiuje aktualne zasoby do Androida i rejestruje pluginy natywne.

## Debug APK

Na Windows ustaw JDK 21 i ścieżkę SDK z Android Studio, a następnie zbuduj APK:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
& "$env:JAVA_HOME\bin\java.exe" -version
& (Join-Path $androidRoot 'gradlew.bat') -p $androidRoot assembleDebug
$apkPath = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
Test-Path -LiteralPath $apkPath
```

Android Studio może też otworzyć katalog `android/` bezpośrednio. Przy instalacji przez USB włącz na telefonie GrapheneOS **Developer options → USB debugging**, podłącz kabel obsługujący dane i zaakceptuj klucz komputera. Następnie:

```powershell
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
& $adb devices
& $adb install -r $apkPath
```

Możesz też skopiować APK na telefon i zezwolić aplikacji otwierającej plik na instalowanie nieznanych aplikacji. Po instalacji wyłącz USB debugging, jeśli nie jest już potrzebny.

## Ograniczenia tej wersji

Ekran jest placeholderem. Nie zawiera jeszcze schematu bazy, migracji, zapisu jedzenia, Pantry, importu ani synchronizacji. Próba `gradlew.bat -p .\android assembleDebug` zakończyła się przed kompilacją komunikatem `JAVA_HOME is set to an invalid directory`, ponieważ wskazany JDK `C:\Program Files\Android\Android Studio\jbr` nie istnieje w tym środowisku. Android SDK nie był dostępny do odczytu. APK nie powstał; ustaw działający JDK 21 i ścieżkę SDK przed budowaniem.
