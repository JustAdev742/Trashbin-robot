// =====================================================================
//  SUNBURN DEVICE  -  micro:bit firmware 3.1
// =====================================================================
//  A UV wearable that follows the "Sunburn Flowchart":
//  read the UV sensor, combine it with the online UV index from a phone,
//  then flash, beep or tap the arm until the wearer puts sunscreen on,
//  and remind them again two hours later.
//
//  Sections (same order and numbers as the notes in the Blocks view):
//    1  Start here: settings        6  Sound and servo
//    2  The flowchart               7  Bluetooth and serial
//    3  Buttons                     8  Helpers
//    4  Alerts                      9  OLED screen driver (optional)
//    5  Screen and LEDs
//
//  Pins: UV sensor P1 (readUvSensor), servo P2 (servoAngle), buzzer P0
//        (setupSound), OLED on the I2C pins P19 / P20 (oledCommand).
//  Setup in MakeCode: Extensions -> bluetooth, Project settings -> No Pairing Required
// =====================================================================


// ===== 1. START HERE: SETTINGS =====

// UV sensor on P1.  1 = GUVA-S12SD / Crowtail / Grove / DFRobot / ElecFreaks
// 2 = ML8511 (SparkFun, Adafruit)   3 = sensors sold as "0-1023 = UV 0-15"
let uvSensorType = 1
// One reading is the middle value of this many samples (kills noise spikes)
let uvSampleCount = 15

// Sound: 1 = micro:bit V2 speaker, 2 = buzzer on P0 (a V1 always uses P0)
let soundOutput = 1

// Servo on P2: 1 = normal positional servo, 2 = continuous rotation servo
let servoType = 1
// Angles for a positional servo: resting, and the tap
let servoRestAngle = 90
let servoTapAngle = 30

// OLED screen on the I2C pins (optional).  0 = no screen, 1 = detect it, 2 = always on
let oledMode = 1
// 1 = SSD1306 (most 0.96" screens), 2 = SH1106 (most 1.3" screens)
let oledType = 1
// I2C address: 60 = 0x3C (usual), 61 = 0x3D
let oledAddress = 60

// UV bands from the flowchart (WHO scale), tested on the rounded UV index:
// 0-2 low, 3-7 moderate / high, 8-10 very high, 11+ extreme
let uvLowMax = 2
let uvHighMax = 7
let uvVeryHighMax = 10

// Timings from the flowchart
let waitMinutes = 5
let reapplyHours = 2
let tapMaxMinutes = 2
// Safety limits: how long an alert beeps before giving up, and how long a
// value from the phone counts as "the phone is sending online UV"
let alertGiveUpMinutes = 10
let onlineUvMaxAgeMinutes = 30
let sensorRetrySeconds = 5
let firmwareVersion = "3.1"

// ----- State variables: the program updates these itself -----
// (variables that start at 0, false or empty do not show in Blocks)
let demoMode = false
let deviceOn = false
let stateName = ""
let currentUv = 0
let currentBand = ""
let sensorRaw = 0
let sensorNoise = 0
let sensorVolts = 0
let sensorUv = 0
let onlineUv = 0
let onlineUvTime = 0
let reapplyTimerRunning = false
let reapplyDueTime = 0
let protectionLevel = 0
let sunscreenCount = 0
let ackPressed = false
let anyButtonPressed = false
let btConnected = false
let oledPresent = false
let debugMode = false
let sensorErrorReported = false
let skipMessage = false
let wentToStandby = false
let uvZeroVolts = 0
let uvVoltsPerIndex = 0
let waitMs = 0
let reapplyMs = 0
let alertGiveUpMs = 0
let tapMaxMs = 0
let fontBytes: number[] = []
let nibbleStretch: number[] = []

// ----- Device turns on -----
applySensorPreset()
applyTimings()
setupSound()
setupOled()
advertiseOverBluetooth()
// Hold B while switching on for demo timings: 10 s waits and a 1 minute sunscreen timer
if (input.buttonIsPressed(Button.B)) {
    demoMode = true
    applyTimings()
}
deviceTurnsOn()


// ===== 2. THE FLOWCHART =====

// Forever: one trip around the flowchart, then straight back to "Read UV sensor"
basic.forever(function () {
    if (deviceOn) {
        runFlowchart()
    } else {
        basic.pause(500)
    }
})

// The flowchart from top to bottom. Every box and decision is a function below,
// named after the box. "A and B held?" is the A+B button block: it turns the
// device off at any moment; every wait stops as soon as that happens and the
// rest of the trip is skipped. A branch that ended in standby goes straight
// back to "Read UV sensor" instead of waiting 5 minutes.
function runFlowchart() {
    readUvSensor()
    if (sensorReadingInRange()) {
        chooseUvValue()
        showUvReading()
        currentBand = uvBand(currentUv)
        wentToStandby = false
        if (currentBand == "low") {
            showHappyFace()
        } else if (currentBand == "modhigh") {
            moderateOrHighUv()
        } else if (currentBand == "vhigh") {
            veryHighUv()
        } else {
            extremeUv()
        }
        if (deviceOn && !wentToStandby) {
            wait5Minutes()
            if (deviceOn && reapplyTimerExpired()) {
                showReapplySunscreen()
            }
        }
    } else {
        showCheckSensor()
    }
}

// Box: Read UV sensor.  Analog pin P1. Takes the middle value of several
// samples so one noisy sample cannot set off a false alarm.
function readUvSensor() {
    stateName = "reading"
    let samples: number[] = []
    for (let sampleIndex = 0; sampleIndex < uvSampleCount; sampleIndex++) {
        samples.push(pins.analogReadPin(AnalogPin.P1))
        basic.pause(2)
    }
    sortNumbers(samples)
    sensorRaw = samples[Math.floor(uvSampleCount / 2)]
    sensorNoise = samples[uvSampleCount - 1] - samples[0]
    sensorVolts = sensorRaw * 3.3 / 1023
    sensorUv = (sensorVolts - uvZeroVolts) / uvVoltsPerIndex
    debugLog("raw " + sensorRaw + " noise " + sensorNoise)
}

// Decision: Sensor reading in range?  No when the pin is stuck at the top of its
// range (sensor missing or shorted), the samples jump about (loose wire),
// or the UV number cannot be real.
function sensorReadingInRange(): boolean {
    let inRange = true
    if (sensorRaw >= 1020) {
        inRange = false
    }
    if (sensorNoise > 200) {
        inRange = false
    }
    if (sensorUv < -1.5 || sensorUv > 20) {
        inRange = false
    }
    if (inRange) {
        sensorErrorReported = false
    }
    return inRange
}

// Box: Show CHECK SENSOR, beep, retry in 5 s.  A bad sensor is never treated as
// "safe". The app gets one ev=error per problem, not one per retry.
function showCheckSensor() {
    stateName = "error"
    if (!sensorErrorReported) {
        sendLine("ev=error;msg=CHECK SENSOR")
        sensorErrorReported = true
    }
    basic.showIcon(IconNames.No)
    showMessage("CHECK SENSOR")
    oledFooter("pin " + formatNumber(sensorVolts) + " V")
    beep(440, 200)
    beep(440, 200)
    basic.pause(sensorRetrySeconds * 1000)
}

// Decision: Phone connected and sending online UV?  Yes while a UV value from
// the app (over Bluetooth or USB) arrived in the last 30 minutes.
function phoneSendingOnlineUv(): boolean {
    let age = input.runningTime() - onlineUvTime
    let maxAge = onlineUvMaxAgeMinutes * 60000
    return onlineUvTime > 0 && age < maxAge
}

// Boxes: UV = higher of sensor and online  /  UV = sensor value
function chooseUvValue() {
    currentUv = Math.max(0, sensorUv)
    if (phoneSendingOnlineUv()) {
        currentUv = Math.max(currentUv, onlineUv)
    }
}

// Decision: UV index?  Returns the flowchart branch for a UV index:
// "low" (0-2), "modhigh" (3-7), "vhigh" (8-10) or "extreme" (11+)
function uvBand(uv: number): string {
    let rounded = Math.round(uv)
    let band = "extreme"
    if (rounded <= uvLowMax) {
        band = "low"
    } else if (rounded <= uvHighMax) {
        band = "modhigh"
    } else if (rounded <= uvVeryHighMax) {
        band = "vhigh"
    }
    return band
}

// Branch 0-2 low: Show happy face
function showHappyFace() {
    stateName = "safe"
    basic.showIcon(IconNames.Happy)
    oledShowMessage("Low UV. No sunscreen needed")
}

// Branch 3-7 moderate / high: Flash and slow beep until A is pressed, show how
// much sunscreen to put on, then start the 2 hour reapply timer.
// The flowchart comes back here every 5 minutes, so it only alerts while no
// sunscreen is on (no timer running). Otherwise it just shows the time left.
// If nobody presses A within alertGiveUpMinutes the device is probably not
// being worn, so it goes to standby until a button is pressed.
function moderateOrHighUv() {
    if (protectionLevel == 0) {
        stateName = "alert"
        showMessage("Sunscreen time")
        flashAndBeepUntilA(false)
        if (ackPressed) {
            showMessage("1 tsp SPF 50+ on each arm, each leg, front, back and face")
            sunscreenApplied(1)
        } else if (deviceOn) {
            standbyUntilButton()
        }
    } else {
        alreadyProtected()
    }
}

// Branch 8-10 very high: Flash and fast beep until A is pressed, sunscreen as
// above plus hat and shade, then start the 2 hour reapply timer.
// Alerts again if the wearer only had the moderate / high advice so far.
// No answer within alertGiveUpMinutes means standby, as above.
function veryHighUv() {
    if (protectionLevel < 2) {
        stateName = "alert"
        showMessage("Very high UV")
        flashAndBeepUntilA(true)
        if (ackPressed) {
            showMessage("1 tsp SPF 50+ on each arm, each leg, front, back and face. Wear a hat and seek shade")
            sunscreenApplied(2)
        } else if (deviceOn) {
            standbyUntilButton()
        }
    } else {
        alreadyProtected()
    }
}

// Branch 11+ extreme: Tap the arm until A is pressed (max 2 min, then beep
// instead), show go inside now, then standby until any button is pressed.
// The app only hears ev=inside when somebody actually pressed A.
function extremeUv() {
    stateName = "alert"
    tapArmUntilA()
    if (deviceOn) {
        showMessage("Go inside now. Sunscreen on the way")
        if (ackPressed) {
            sendEvent("inside")
        }
        standbyUntilButton()
    }
}

// A was pressed after a sunscreen alert: remember the advice level, count it,
// tell the app, and start the timer
function sunscreenApplied(level: number) {
    basic.showIcon(IconNames.Yes)
    protectionLevel = level
    sunscreenCount += 1
    sendEvent("sunscreen")
    start2HourReapplyTimer()
}

// Box: Start 2 hour reapply timer
function start2HourReapplyTimer() {
    reapplyTimerRunning = true
    reapplyDueTime = input.runningTime() + reapplyMs
}

// Sunscreen is already on: no alert, just a tick and the time until reapply
function alreadyProtected() {
    stateName = "protected"
    basic.showIcon(IconNames.Yes)
    let timeLeft = reapplyDueTime - input.runningTime()
    oledShowMessage("Sunscreen on. Reapply in " + formatTime(timeLeft))
}

// Box: Wait 5 minutes.  Ends early if the device is turned off or the reapply
// timer runs out. Pressing A while waiting shows the UV index and the countdown.
function wait5Minutes() {
    stateName = "wait"
    ackPressed = false
    let waitEndTime = input.runningTime() + waitMs
    let timeLeft = waitMs
    while (deviceOn && timeLeft > 0 && !reapplyTimerExpired()) {
        oledFooter("Next " + formatTime(timeLeft) + reapplyCountdownText())
        if (ackPressed) {
            ackPressed = false
            showLedStatus()
        }
        basic.pause(1000)
        timeLeft = waitEndTime - input.runningTime()
    }
}

// Decision: Reapply timer expired?
function reapplyTimerExpired(): boolean {
    return reapplyTimerRunning && input.runningTime() >= reapplyDueTime
}

// Box: Show reapply sunscreen.  Clears the timer, so the next trip round the
// flowchart alerts again (if UV is still 3 or more) and starts a fresh 2 hours.
function showReapplySunscreen() {
    stateName = "alert"
    reapplyTimerRunning = false
    protectionLevel = 0
    sendEvent("reapply")
    basic.showIcon(IconNames.Sad)
    showMessage("Reapply sunscreen")
}

// Terminal: Device turns on.  Runs at start-up and when A+B turns it back on.
function deviceTurnsOn() {
    stateName = "on"
    basic.showIcon(IconNames.Yes)
    oledHeader()
    if (demoMode) {
        oledShowMessage("Device on (demo)")
    } else {
        oledShowMessage("Device on")
    }
    oledFooter("Waiting for phone")
    servoOff()
    sendEvent("on")
    basic.pause(1500)
    deviceOn = true
}

// Terminal: Device turns off.  Everything stops. Bluetooth stays up so the
// app can still turn it on again.
function deviceTurnsOff() {
    deviceOn = false
    stateName = "off"
    servoOff()
    basic.clearScreen()
    oledClear()
    oledWriteRow(3, "        OFF")
    oledWriteRow(5, "A+B to turn on")
    sendEvent("off")
}


// ===== 3. BUTTONS =====

// A = "done": sunscreen is on / I am going inside.  Also wakes from standby,
// skips a message scrolling on the LEDs, and while the device is waiting it
// shows the UV index and the countdown.
input.onButtonPressed(Button.A, function () {
    ackPressed = true
    anyButtonPressed = true
    skipMessage = true
})

// B = wake from standby.  (Hold B while switching on for demo timings.)
input.onButtonPressed(Button.B, function () {
    anyButtonPressed = true
})

// A + B = device turns off, or back on
input.onButtonPressed(Button.AB, function () {
    if (deviceOn) {
        deviceTurnsOff()
    } else {
        deviceTurnsOn()
    }
})


// ===== 4. ALERTS =====

// Flash all the LEDs and beep until A is pressed (or the app sends "ack").
// fast = true is the quicker, higher beep for very high UV.
// Gives up after alertGiveUpMinutes so a device left on a table does not beep
// all day; the caller then goes to standby.
function flashAndBeepUntilA(fast: boolean) {
    ackPressed = false
    let beatMs = 500
    let tone = 523
    if (fast) {
        beatMs = 150
        tone = 659
    }
    let giveUpTime = input.runningTime() + alertGiveUpMs
    while (stillWaitingForA(giveUpTime)) {
        ledsAllOn()
        beep(tone, beatMs)
        basic.clearScreen()
        basic.pause(beatMs)
    }
}

// The servo taps the arm until A is pressed.  After tapMaxMinutes it beeps
// instead, so a device that is not being worn does not run the motor flat.
function tapArmUntilA() {
    ackPressed = false
    basic.showIcon(IconNames.Angry)
    let stopTappingTime = input.runningTime() + tapMaxMs
    while (stillWaitingForA(stopTappingTime)) {
        servoTapOnce()
    }
    servoOff()
    if (!ackPressed && deviceOn) {
        flashAndBeepUntilA(true)
    }
}

// True while an alert should carry on: no A yet, device still on, time limit not reached
function stillWaitingForA(untilTime: number): boolean {
    return !ackPressed && deviceOn && input.runningTime() < untilTime
}

// Box: Standby until any button is pressed (A, B, or "ack" from the app).
// A+B still turns the device off. Afterwards the flowchart goes straight
// back to "Read UV sensor" (no 5 minute wait).
function standbyUntilButton() {
    wentToStandby = true
    stateName = "standby"
    sendEvent("standby")
    anyButtonPressed = false
    basic.showIcon(IconNames.Asleep)
    oledShowMessage("Standby. Press a button to check again")
    oledFooter("")
    while (deviceOn && !anyButtonPressed) {
        basic.pause(200)
    }
}


// ===== 5. SCREEN AND LEDS =====

// The rounded UV index on the LEDs; the exact number, band and source on the OLED
function showUvReading() {
    oledHeader()
    let source = "sensor"
    if (phoneSendingOnlineUv()) {
        source = "sensor+app"
    }
    oledWriteBig(1, 0, "UV " + formatNumber(currentUv))
    oledWriteRow(3, uvBandName(currentUv) + "  " + source)
    basic.showNumber(Math.round(currentUv))
    basic.pause(500)
}

// The words for the OLED: LOW, MODERATE, HIGH, VERY HIGH or EXTREME
function uvBandName(uv: number): string {
    let rounded = Math.round(uv)
    let name = "EXTREME"
    if (rounded <= uvLowMax) {
        name = "LOW"
    } else if (rounded <= 5) {
        name = "MODERATE"
    } else if (rounded <= uvHighMax) {
        name = "HIGH"
    } else if (rounded <= uvVeryHighMax) {
        name = "VERY HIGH"
    }
    return name
}

// Pressing A while waiting: the UV index and the time until reapply scroll across
// the LEDs, then the icon comes back
function showLedStatus() {
    basic.showString("UV " + Math.round(currentUv) + reapplyCountdownText())
    if (protectionLevel > 0) {
        basic.showIcon(IconNames.Yes)
    } else if (currentBand == "low") {
        basic.showIcon(IconNames.Happy)
    } else {
        basic.clearScreen()
    }
}

// A message: on the OLED if there is one, otherwise scrolled across the LEDs one
// word at a time. Pressing A skips the rest of a long message.
function showMessage(text: string) {
    if (oledPresent) {
        oledShowMessage(text)
    } else {
        skipMessage = false
        let words = text.split(" ")
        for (let word of words) {
            if (!skipMessage && word.length > 0) {
                basic.showString(word)
            }
        }
    }
}

// All 25 LEDs on (the "flash")
function ledsAllOn() {
    basic.showLeds(`
        # # # # #
        # # # # #
        # # # # #
        # # # # #
        # # # # #
        `)
}

// OLED row 0: the title and a Bluetooth star while a phone is connected
function oledHeader() {
    if (btConnected) {
        oledWriteRow(0, "SUNBURN DEVICE   BT*")
    } else {
        oledWriteRow(0, "SUNBURN DEVICE   BT ")
    }
}

// OLED rows 4-6: a message, word-wrapped over three lines of 21 characters
function oledShowMessage(text: string) {
    let words = text.split(" ")
    let lines: string[] = []
    let line = ""
    for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
        let word = words[wordIndex]
        if (line.length == 0) {
            line = word
        } else if (line.length + 1 + word.length <= 21) {
            line = line + " " + word
        } else {
            lines.push(line)
            line = word
        }
    }
    lines.push(line)
    for (let lineIndex = 0; lineIndex < 3; lineIndex++) {
        if (lineIndex < lines.length) {
            oledWriteRow(4 + lineIndex, lines[lineIndex])
        } else {
            oledWriteRow(4 + lineIndex, "")
        }
    }
}

// OLED row 7: the countdowns
function oledFooter(text: string) {
    oledWriteRow(7, text)
}


// ===== 6. SOUND AND SERVO =====

// V2 speaker, or a buzzer on P0
function setupSound() {
    if (soundOutput == 2) {
        pins.analogSetPitchPin(AnalogPin.P0)
    }
    music.setVolume(255)
}

// One beep: frequency in Hz (523 = C5, 659 = E5, 440 = A4), length in ms
function beep(frequency: number, ms: number) {
    music.play(music.tonePlayable(frequency, ms), music.PlaybackMode.UntilDone)
}

// The servo signal wire is on P2
function servoAngle(angle: number) {
    pins.servoWritePin(AnalogPin.P2, angle)
}

// Rest position, then stop the pulses so the servo is silent and uses no power
function servoOff() {
    if (servoType == 2) {
        servoAngle(90)
    } else {
        servoAngle(servoRestAngle)
    }
    basic.pause(300)
    pins.digitalWritePin(DigitalPin.P2, 0)
}

// One tap of the arm (about half a second)
function servoTapOnce() {
    if (servoType == 2) {
        servoAngle(0)
        basic.pause(150)
        servoAngle(90)
        basic.pause(100)
        servoAngle(180)
        basic.pause(150)
        servoAngle(90)
        basic.pause(250)
    } else {
        servoAngle(servoTapAngle)
        basic.pause(220)
        servoAngle(servoRestAngle)
        basic.pause(330)
    }
}


// ===== 7. BLUETOOTH AND SERIAL =====
//
//  Device -> app every 2 s:  st=wait;uv=7.3;sen=7.1;onl=6.5;band=vhigh;spf=5400;spfn=3;fw=3.0
//  Device -> app on events:  ev=on  off  sunscreen  reapply  inside  standby  error
//  App -> device commands:   uv=6.5  ack  zero  cal=7.0  demo=1  power=0  debug=1  ping  read

// Box: Advertise over Bluetooth so a phone can connect (UART service). The same
// lines also go over USB serial, so a laptop can test everything without a phone.
function advertiseOverBluetooth() {
    serial.redirectToUSB()
    bluetooth.startUartService()
}

// A phone connected: say hello and send the current status straight away
bluetooth.onBluetoothConnected(function () {
    btConnected = true
    oledHeader()
    sendLine("hello;fw=" + firmwareVersion)
    sendStatus()
})

bluetooth.onBluetoothDisconnected(function () {
    btConnected = false
    oledHeader()
})

// A command line arrived over Bluetooth
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    handleCommand(bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine)))
})

// A command line arrived over USB serial
serial.onDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    handleCommand(serial.readUntil(serial.delimiters(Delimiters.NewLine)))
})

// Status line for the app every 2 seconds
loops.everyInterval(2000, function () {
    sendStatus()
})

// One line of text to USB serial, and to the phone when one is connected
function sendLine(text: string) {
    serial.writeLine(text)
    if (btConnected) {
        bluetooth.uartWriteLine(text)
    }
}

// Tells the app something happened, e.g. ev=sunscreen
function sendEvent(name: string) {
    sendLine("ev=" + name)
}

// The status line: state, UV values, band, seconds until reapply, sunscreen
// count, firmware version, and whether demo timings are on
function sendStatus() {
    let reapplySeconds = -1
    if (reapplyTimerRunning) {
        let msLeft = reapplyDueTime - input.runningTime()
        reapplySeconds = Math.max(0, Math.floor(msLeft / 1000))
    }
    let onlineText = "-1"
    if (phoneSendingOnlineUv()) {
        onlineText = formatNumber(onlineUv)
    }
    let status = "st=" + stateName
    status = status + ";uv=" + formatNumber(currentUv)
    status = status + ";sen=" + formatNumber(Math.max(0, sensorUv))
    status = status + ";onl=" + onlineText
    status = status + ";band=" + uvBand(currentUv)
    status = status + ";spf=" + reapplySeconds
    status = status + ";spfn=" + sunscreenCount
    status = status + ";fw=" + firmwareVersion
    if (demoMode) {
        status = status + ";demo=1"
    } else {
        status = status + ";demo=0"
    }
    sendLine(status)
}

// One command per line from the app or the serial console: "key=value" or just "key"
function handleCommand(command: string) {
    let parts = cleanText(command).split("=")
    let key = parts[0]
    let value = ""
    if (parts.length > 1) {
        value = parts[1]
    }
    debugLog("cmd " + key + " " + value)
    if (key == "uv") {
        let newUv = parseFloat(value)
        if (newUv >= 0 && newUv <= 20) {
            onlineUv = newUv
            onlineUvTime = input.runningTime()
            sendLine("ok=uv")
        } else {
            sendLine("err=uv")
        }
    } else if (key == "ack") {
        ackPressed = true
        anyButtonPressed = true
        sendLine("ok=ack")
    } else if (key == "zero") {
        readUvSensor()
        uvZeroVolts = sensorVolts
        sendLine("ok=zero;v=" + formatNumber(uvZeroVolts))
    } else if (key == "cal") {
        calibrateToKnownUv(parseFloat(value))
    } else if (key == "demo") {
        demoMode = value == "1"
        applyTimings()
        sendLine("ok=demo")
    } else if (key == "power") {
        if (value == "0" && deviceOn) {
            deviceTurnsOff()
        } else if (value == "1" && !deviceOn) {
            deviceTurnsOn()
        }
    } else if (key == "debug") {
        debugMode = value == "1"
        sendLine("ok=debug")
    } else if (key == "ping") {
        let oledText = "0"
        if (oledPresent) {
            oledText = "1"
        }
        sendLine("pong;fw=" + firmwareVersion + ";oled=" + oledText)
    } else if (key == "read") {
        sendStatus()
    } else if (key.length > 0) {
        sendLine("err=unknown")
    }
}

// Live calibration: send cal=7 while a weather site says the UV index is 7
// and the sensor is in the sun. Send "zero" in the dark first if needed.
function calibrateToKnownUv(knownUv: number) {
    readUvSensor()
    if (knownUv > 0 && sensorVolts > uvZeroVolts) {
        uvVoltsPerIndex = (sensorVolts - uvZeroVolts) / knownUv
        sendLine("ok=cal")
    } else {
        sendLine("err=cal")
    }
}


// ===== 8. HELPERS =====

// The maths for each sensor type: UV index = (volts - uvZeroVolts) / uvVoltsPerIndex
function applySensorPreset() {
    uvZeroVolts = 0
    uvVoltsPerIndex = 0.1
    if (uvSensorType == 2) {
        uvZeroVolts = 1
        uvVoltsPerIndex = 0.12
    }
    if (uvSensorType == 3) {
        uvVoltsPerIndex = 0.22
    }
}

// Turns the minutes and hours in the settings into milliseconds.
// Demo mode uses fast timings so the whole flowchart can be shown in a few minutes.
function applyTimings() {
    if (demoMode) {
        waitMs = 10000
        reapplyMs = 60000
        alertGiveUpMs = 20000
        tapMaxMs = 15000
    } else {
        waitMs = waitMinutes * 60000
        reapplyMs = reapplyHours * 3600000
        alertGiveUpMs = alertGiveUpMinutes * 60000
        tapMaxMs = tapMaxMinutes * 60000
    }
}

// Sorts a list of numbers from smallest to largest (insertion sort)
function sortNumbers(list: number[]) {
    for (let sortIndex = 0; sortIndex < list.length - 1; sortIndex++) {
        let movingValue = list[sortIndex + 1]
        let slot = sortIndex
        while (slot >= 0 && list[slot] > movingValue) {
            list[slot + 1] = list[slot]
            slot = slot - 1
        }
        list[slot + 1] = movingValue
    }
}

// A number with one decimal place: 7.25 -> "7.3"
function formatNumber(n: number): string {
    let rounded = Math.round(n * 10) / 10
    let wholePart = Math.floor(Math.abs(rounded))
    let tenthPart = Math.round((Math.abs(rounded) - wholePart) * 10)
    let sign = ""
    if (rounded < 0) {
        sign = "-"
    }
    return sign + wholePart + "." + tenthPart
}

// Milliseconds as a clock: 90000 -> "1:30", 7200000 -> "2h00"
function formatTime(ms: number): string {
    let totalSeconds = Math.floor(Math.max(0, ms) / 1000)
    let hours = Math.floor(totalSeconds / 3600)
    let minutes = Math.floor(totalSeconds / 60) % 60
    let seconds = totalSeconds % 60
    let timeText = ""
    if (hours == 0) {
        timeText = minutes + ":" + twoDigits(seconds)
    } else {
        timeText = hours + "h" + twoDigits(minutes)
    }
    return timeText
}

// 7 -> "07", 42 -> "42"
function twoDigits(n: number): string {
    let digits = "" + n
    if (n < 10) {
        digits = "0" + n
    }
    return digits
}

// "  SPF 1h23" for the OLED footer while the reapply timer is running
function reapplyCountdownText(): string {
    let countdown = ""
    if (reapplyTimerRunning) {
        let timeLeft = reapplyDueTime - input.runningTime()
        countdown = "  SPF " + formatTime(timeLeft)
    }
    return countdown
}

// Removes spaces and line endings from both ends of a command
function cleanText(text: string): string {
    let cleaned = text
    let lastCode = cleaned.charCodeAt(cleaned.length - 1)
    while (cleaned.length > 0 && isBlank(lastCode)) {
        cleaned = cleaned.substr(0, cleaned.length - 1)
        lastCode = cleaned.charCodeAt(cleaned.length - 1)
    }
    while (cleaned.length > 0 && isBlank(cleaned.charCodeAt(0))) {
        cleaned = cleaned.substr(1, cleaned.length - 1)
    }
    return cleaned
}

// Character codes 32 = space, 13 = return, 10 = new line
function isBlank(code: number): boolean {
    return code == 32 || code == 13 || code == 10
}

// Extra "dbg:" lines on the serial console after the command debug=1
function debugLog(text: string) {
    if (debugMode) {
        serial.writeLine("dbg:" + text)
    }
}


// ===== 9. OLED SCREEN DRIVER  (optional: only used if you add a 128x64 I2C screen) =====

// Looks for a screen and sets it up. The program works exactly the same without one.
function setupOled() {
    oledPresent = false
    if (oledMode > 0) {
        loadFont()
        buildNibbleTable()
        oledCommand(174)
        let screenStatus = pins.i2cReadNumber(oledAddress, NumberFormat.UInt8LE, false)
        if (oledMode == 2 || screenStatus == 64) {
            oledInitCommands()
            oledPresent = true
            oledClear()
        }
    }
}

// The standard start-up sequence for SSD1306 and SH1106 screens
function oledInitCommands() {
    oledCommand(213)
    oledCommand(128)
    oledCommand(168)
    oledCommand(63)
    oledCommand(211)
    oledCommand(0)
    oledCommand(64)
    if (oledType == 2) {
        oledCommand(173)
        oledCommand(139)
    } else {
        oledCommand(141)
        oledCommand(20)
        oledCommand(32)
        oledCommand(2)
    }
    oledCommand(161)
    oledCommand(200)
    oledCommand(218)
    oledCommand(18)
    oledCommand(129)
    oledCommand(207)
    oledCommand(217)
    oledCommand(241)
    oledCommand(219)
    oledCommand(64)
    oledCommand(164)
    oledCommand(166)
    oledCommand(175)
}

// A 5x7 font for characters 32-126, stored as hex text and unpacked into fontBytes
function loadFont() {
    let hex = ""
    hex = hex + "000000000000005f00000007000700147f147f14242a7f2a12231308646236495522500005030000001c22410000412"
    hex = hex + "21c0014083e081408083e080800503000000808080808006060000020100804023e5149453e00427f40004261514946"
    hex = hex + "2141454b311814127f1027454545393c4a49493001710905033649494936064949291e0036360000005636000008142"
    hex = hex + "24100141414141400412214080201510906324979413e7e1111117e7f494949363e414141227f4141221c7f49494941"
    hex = hex + "7f090909013e4149497a7f0808087f00417f41002040413f017f081422417f404040407f020c027f7f0408107f3e414"
    hex = hex + "1413e7f090909063e4151215e7f09192946464949493101017f01013f4040403f1f2040201f3f4038403f6314081463"
    hex = hex + "07087008076151494543007f41410002040810200041417f0004020102044040404040000102040020545454787f484"
    hex = hex + "444383844444420384444487f3854545418087e0901020c5252523e7f0804047800447d40002040443d007f10284400"
    hex = hex + "00417f40007c041804787c0804047838444444387c14141408081414187c7c080404084854545420043f4440203c404"
    hex = hex + "0207c1c2040201c3c4030403c44281028440c5050503c4464544c44000836410000007f0000004136080008082a1c08"
    let hexDigits = "0123456789abcdef"
    fontBytes = []
    for (let fontIndex = 0; fontIndex < 475; fontIndex++) {
        let highDigit = hexDigits.indexOf(hex.charAt(fontIndex * 2))
        let lowDigit = hexDigits.indexOf(hex.charAt(fontIndex * 2 + 1))
        fontBytes.push(highDigit * 16 + lowDigit)
    }
}

// Table for double-size text: each of the 4 bits in a nibble is doubled (0101 -> 00110011)
function buildNibbleTable() {
    nibbleStretch = []
    for (let nibble = 0; nibble < 16; nibble++) {
        let remaining = nibble
        let stretched = 0
        let weight = 3
        for (let bit = 0; bit < 4; bit++) {
            if (remaining % 2 == 1) {
                stretched += weight
            }
            remaining = Math.floor(remaining / 2)
            weight = weight * 4
        }
        nibbleStretch.push(stretched)
    }
}

// One column (0-4) of one character
function fontByte(code: number, column: number): number {
    let safeCode = code
    if (safeCode < 32 || safeCode > 126) {
        safeCode = 63
    }
    return fontBytes[(safeCode - 32) * 5 + column]
}

// Sends one command byte (control byte 0, then the command)
function oledCommand(command: number) {
    pins.i2cWriteNumber(oledAddress, command, NumberFormat.UInt16BE, false)
}

// Sends three pixel-data bytes (control byte 64, then the data)
function oledData(byte1: number, byte2: number, byte3: number) {
    let packet = byte1 * 65536
    packet += byte2 * 256
    packet += byte3
    pins.i2cWriteNumber(oledAddress, 1073741824 + packet, NumberFormat.UInt32BE, false)
}

// Moves the cursor: page = 8-pixel row (0-7), col = pixel column (0-127)
function oledSetPosition(page: number, col: number) {
    let pixelColumn = col
    if (oledType == 2) {
        pixelColumn += 2
    }
    oledCommand(176 + page)
    oledCommand(pixelColumn % 16)
    oledCommand(16 + Math.floor(pixelColumn / 16))
}

// Blanks the whole screen
function oledClear() {
    if (oledPresent) {
        for (let clearPage = 0; clearPage < 8; clearPage++) {
            oledSetPosition(clearPage, 0)
            for (let packetIndex = 0; packetIndex < 43; packetIndex++) {
                oledData(0, 0, 0)
            }
        }
    }
}

// Small text: 21 characters per row, 8 rows
function oledWriteText(row: number, col: number, text: string) {
    if (oledPresent) {
        let smallText = text
        if (smallText.length > 21 - col) {
            smallText = smallText.substr(0, 21 - col)
        }
        oledSetPosition(row, col * 6)
        for (let charIndex = 0; charIndex < smallText.length; charIndex++) {
            let charCode = smallText.charCodeAt(charIndex)
            oledData(fontByte(charCode, 0), fontByte(charCode, 1), fontByte(charCode, 2))
            oledData(fontByte(charCode, 3), fontByte(charCode, 4), 0)
        }
    }
}

// Writes a whole row, padding with spaces so old text is wiped
function oledWriteRow(row: number, text: string) {
    let rowText = text
    while (rowText.length < 21) {
        rowText = rowText + " "
    }
    oledWriteText(row, 0, rowText)
}

// Double-size text: two rows tall, up to 10 characters
function oledWriteBig(row: number, col: number, text: string) {
    if (oledPresent) {
        let bigText = text
        if (bigText.length > 10) {
            bigText = bigText.substr(0, 10)
        }
        for (let half = 0; half < 2; half++) {
            oledSetPosition(row + half, col * 6)
            for (let bigCharIndex = 0; bigCharIndex < bigText.length; bigCharIndex++) {
                let bigCharCode = bigText.charCodeAt(bigCharIndex)
                let stretchedColumns: number[] = []
                for (let columnIndex = 0; columnIndex < 6; columnIndex++) {
                    let glyphColumn = 0
                    if (columnIndex < 5) {
                        glyphColumn = fontByte(bigCharCode, columnIndex)
                    }
                    if (half == 0) {
                        stretchedColumns.push(nibbleStretch[glyphColumn % 16])
                    } else {
                        stretchedColumns.push(nibbleStretch[Math.floor(glyphColumn / 16)])
                    }
                }
                oledData(stretchedColumns[0], stretchedColumns[0], stretchedColumns[1])
                oledData(stretchedColumns[1], stretchedColumns[2], stretchedColumns[2])
                oledData(stretchedColumns[3], stretchedColumns[3], stretchedColumns[4])
                oledData(stretchedColumns[4], stretchedColumns[5], stretchedColumns[5])
            }
        }
    }
}
