# Ggent — Pantry na Androida

Pantry zapisuje presety i wpisy jedzenia w trwałej bazie SQLite na Androidzie. Wpis przechowuje własny snapshot makr, więc późniejsza zmiana presetu nie zmienia historii. Ekran zawiera wyszukiwanie i kafelki produktów, klawiaturę gramów oraz listę dzisiejszych wpisów z edycją i usuwaniem. Kafelek „＋ Nowy produkt” otwiera formularz tworzenia. Ikona edycji na klawiaturze gramów otwiera formularz wybranego produktu.

Formularz zapisuje nazwę, kcal i B/W/T na 100 g, opcjonalną wagę jednej sztuki oraz niezależne tagi Śniadanie, Obiad i Kolacja. Zmiana produktu dotyczy przyszłych wpisów; wcześniejsze wpisy zachowują nazwę i makra z chwili zapisu. Usunięcie produktu usuwa tylko kafelek, a jego historia pozostaje dostępna.

## Wymagania

- Node.js 22 lub nowszy.
- Android Studio z wymaganym Android SDK.
- JDK 21 do budowania APK.

## Testy i build

Z katalogu repozytorium uruchom PowerShell i ustaw ścieżki:

```powershell
$repoRoot = 'C:\ścieżka\do\checkoutu'
$appRoot = Join-Path $repoRoot 'android-app'
$androidRoot = Join-Path $appRoot 'android'
npm --prefix "$appRoot" ci
npm --prefix "$appRoot" run test
npm --prefix "$appRoot" run check
npm --prefix "$appRoot" run build
npm --prefix "$appRoot" run build:dev
npm --prefix "$appRoot" run cap:sync
```

`build` sprawdza Svelte i TypeScript, a potem tworzy produkcyjne `dist/`. `build:dev` wykonuje te same kontrole, a następnie tworzy developerskie zasoby z przyciskiem „Wczytaj produkty testowe”. Przycisk dopisuje wyłącznie brakujące, jawnie fikcyjne presety; nie seeduje wpisów jedzenia ani nie nadpisuje istniejących produktów. W produkcyjnym buildzie seeder nie jest dostępny. `cap:sync` kopiuje aktualny `dist/` do Androida, dlatego przed kontrolą na urządzeniu uruchom najpierw `build:dev`, a potem `cap:sync`.

Podgląd w zwykłej przeglądarce pokazuje informację, że trwała baza wymaga Androida. Nie ma pamięciowego ani localStorage fallbacku.

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

Android Studio może też otworzyć katalog `android/` bezpośrednio. Przy instalacji przez USB włącz w telefonie GrapheneOS **Developer options → USB debugging**, podłącz kabel obsługujący dane i zaakceptuj klucz komputera. Następnie:

```powershell
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
& $adb devices
& $adb install -r $apkPath
```

## Ustawienia celów i Slot

Otwórz **⚙ Ustawienia** z ekranu Pantry, aby zmienić dzienne cele kcal, B/W/T oraz lokalne godziny początku obiadu i kolacji. Domyślne wartości to 2000 kcal, 150 g białka, 200 g węglowodanów, 70 g tłuszczu oraz 11:00 i 17:00. Granice Slot zmieniają kolejność kafelków oznaczonych odpowiednim tagiem. Cele są wspólnym źródłem danych dla podsumowania Pantry i logiki przeznaczonej dla historii; ekran historii nie jest częścią tej wersji aplikacji.

## Ręczna kontrola restartu

**Tę kontrolę wykonuje człowiek na telefonie lub emulatorze po merge; model jej nie wykonywał.**

1. Uruchom developerski build i synchronizację zasobów (`npm run build:dev`, potem `npm run cap:sync`), zbuduj i zainstaluj debug APK. Zachowaj to samo `applicationId` między uruchomieniami.
2. W Pantry wybierz „Wczytaj produkty testowe”. Otwórz produkt, dodaj 100 g i zatwierdź. Zanotuj nazwę, wagę i kcal; dotknij nagłówka i potwierdź wpis na liście „Dziś zjedzone”.
3. W ustawieniach Androida wymuś zatrzymanie aplikacji. Nie odinstalowuj jej i nie czyść danych.
4. Otwórz tę samą aplikację ponownie tego samego lokalnego dnia. Sprawdź, że preset, wpis, makra i podsumowanie są zachowane. Powtórz próbę bez sieci, na przykład w trybie samolotowym.
5. Edytuj wpis z 100 g na 150 g, sprawdź proporcjonalne makra, wymuś zatrzymanie i otwórz ponownie. Zmiana powinna pozostać. Usuń wpis, ponownie uruchom aplikację i sprawdź, że wpis nie wrócił.
6. Ponownie wybierz seedy: nie powinny pojawić się duplikaty ani nowe wpisy. Sprawdź również produkcyjny build — nie powinien pokazywać przycisku seedowania.
7. W ustawieniach zmień cel np. na 2200 kcal, zmień B/W/T oraz obie godziny i zapisz. Sprawdź wartości nagłówka oraz kolejność Presetów z pasującymi Slot tags.
8. Wymuś zatrzymanie aplikacji w Androidzie bez odinstalowania jej i bez czyszczenia danych. Otwórz ponownie tę samą aplikację i sprawdź zachowanie wszystkich celów oraz godzin, nagłówka i kolejności kafelków. Powtórz kontrolę offline.
9. Sprawdź mały ekran, przewijanie, anulowanie formularza oraz odświeżenie po wznowieniu aplikacji i przekroczeniu granicy Slot.

Restart na urządzeniu sprawdza człowiek po merge. Model nie wykonywał tej kontroli.

## Ograniczenia

Import i eksport kopii działają w aplikacji Android; podgląd webowy nie ma funkcjonalnej bazy SQLite. Zbudowanie APK i kontrola restartu wymagają Android SDK/JDK oraz urządzenia lub emulatora; sam build webowy nie potwierdza natywnego mostka SQLite.

## Kopia zapasowa JSON

W ekranie **Ustawienia** można udostępnić plik JSON przez systemowy share sheet lub wskazać plik do importu. Format ma `version: 1` oraz tablice `food_presets` i `food_log`. Presety zawierają `slots` (alias danych dla domenowych `slot_tags`); historia zachowuje zapisane makra i metadane każdego wpisu.

Kopia obejmuje wszystkie Presety i całą historię, ale nie obejmuje `app_settings`, celów ani godzin granic Slot. Jeśli wpis historii wskazuje usunięty produkt, eksportowana kopia ustawia jego `preset_id` na `null`; wpis zachowuje zapisaną nazwę, ilość i makra, a lokalny rekord pozostaje bez zmian. Plik v1 przyjmuje wpisy z dodatnią ilością w gramach (`unit: "g"`); rekord bez ilości lub w innej jednostce jest odrzucany w całości. To format kopii Pantry, nie dowolny zrzut bazy desktopowej.

Przy identycznej nazwie produktu pozostaje lokalny Preset, a produkt z kopii jest liczony jako pominięty. Historia nadal jest dopisywana, a jej `preset_id` wskazuje zachowany produkt. Nowe produkty importowane mają oznaczenie „Z Ggent” i gwiazdkę ★. Ponowny import pliku ponownie dopisuje wszystkie jego wpisy historii; import nie próbuje ich zgadywać ani usuwać jako duplikatów. Eksport wymaga wybrania miejsca lub aplikacji w share sheet. Aplikacja nie żąda uprawnień do publicznej pamięci; plik w cache aplikacji nie przetrwa jej odinstalowania.

### Kontrola odtworzenia na telefonie

**Po merge wykonuje ją człowiek; model jej nie wykonywał.**

1. Dodaj kilka produktów z aliasami i tagami Slot oraz wpisy, w tym z wcześniejszego dnia. Zanotuj produkty, makra i sumy.
2. W **Ustawienia → Eksportuj kopię** wybierz miejsce poza prywatnym cache aplikacji. Sprawdź, że share sheet udostępnił plik `.json` i że nie pojawiła się prośba o uprawnienia pamięci.
3. Odinstaluj i zainstaluj tę samą wersję aplikacji. Upewnij się, że baza jest pusta — Android może przywrócić dane automatycznie.
4. W **Ustawienia → Importuj kopię** wybierz zapisany plik. Sprawdź produkty z gwiazdką, aliasy, tagi, wagę sztuki, wpisy, makra i sumy; uruchom aplikację ponownie i sprawdź dane offline. Cele i godziny wracają do wartości domyślnych, bo nie należą do kopii.
5. Sprawdź konflikt nazwy, ponowny import oraz plik uszkodzony i z nieznaną wersją. Błąd ma być po polsku, a nieudany import nie może zmienić danych.
# Historia z ostatnich 7 dni

Przycisk **Historia** w Pantry otwiera wykres kcal dla siedmiu lokalnych dni, w tym dzisiaj. Przerywana linia pokazuje aktualny cel kcal. Dotknij dowolnej daty, także pustej, aby zobaczyć jej zapisane wpisy w trybie tylko do odczytu. Zakres przesuwa się przy odświeżeniu po wznowieniu aplikacji lub przez minutowy timer; wpisy opierają się na zapisanych makrach, nawet jeśli preset później się zmieni.

Kontrolę historii wykonaj na Androidzie: sprawdź 7 dat i linię celu, wybierz dzień pusty oraz dzień z wpisami (w tym dzisiejszy), a następnie dodaj, edytuj i usuń dzisiejszy wpis w Pantry i wróć do historii. Zwykły podgląd webowy nie ma natywnej bazy SQLite. Testy komponentu sprawdzają liczbę dni, wybór pustej daty i listę bez akcji edycji.
