# Sunburn device — micro:bit firmware 3.1

A UV wearable for the BBC micro:bit that follows the **Sunburn Flowchart**: it reads a UV sensor, combines it with the online UV index sent by a phone over Bluetooth, and then flashes, beeps or taps your arm until you put sunscreen on. Two hours later it reminds you to reapply.

The whole program is real MakeCode blocks (no grey JavaScript blocks), laid out in nine numbered sections that follow the flowchart box by box.

![The Blocks view zoomed out: nine numbered sections in two rows](docs/blocks-overview.png)

## 1. Load it

**From the project file**

1. Open [makecode.microbit.org](https://makecode.microbit.org).
2. On the home page click **Import**, then **Import File…**, and choose `sunburn-device.mkcd` (dragging the file onto the editor also works).
3. The project opens in the Blocks view with the Bluetooth extension and the "No Pairing Required" setting already in place.
4. Click **Download** and copy the `.hex` to the micro:bit.

**Straight from GitHub** (works while this repository is public): click **Import**, then **Import URL…**, and paste `https://github.com/JustAdev742/Trashbin-robot`. The `pxt.json`, `main.ts` and `main.blocks` in the root of this repository are the same project.

You need a **micro:bit V2**. Bluetooth plus this program does not fit in a V1's memory; the editor will tell you so if you try (firmware 2.2 had the same limit).

### Reading the Blocks view

Zoom out and you will see nine yellow notes in two rows. Each note is a section heading, and the blocks under it belong to that part of the program:

| Row 1 | Row 2 |
|---|---|
| 1 Start here: settings | 6 Sound and servo |
| 2 The flowchart | 7 Bluetooth and serial |
| 3 Buttons | 8 Helpers |
| 4 Alerts | 9 OLED screen driver (optional) |
| 5 Screen and LEDs | |

Sections 1 and 2 are the whole program. Section 1 is the `on start` block with every setting, and section 2 is the flowchart: `forever` calls `runFlowchart`, and every box and decision on the flowchart is a function with the same name, in the same order (`readUvSensor`, `sensorReadingInRange`, `showCheckSensor`, `phoneSendingOnlineUv`, `chooseUvValue`, `uvBand`, `showHappyFace`, `moderateOrHighUv`, `veryHighUv`, `extremeUv`, `start2HourReapplyTimer`, `wait5Minutes`, `reapplyTimerExpired`, `showReapplySunscreen`, `deviceTurnsOn`, `deviceTurnsOff`). Sections 3 to 9 are the parts those functions call.

Every function block has a comment: click the small **?** icon on a block to read what it does. Do not use **Format code** or **Clean up blocks** from the workspace menu, as that throws the layout away.

## 2. Wiring

Each pin is used in exactly one function, so it is easy to change:

| Part | Pin | Where in the code |
|---|---|---|
| UV sensor, analog OUT | **P1** | `readUvSensor` (3V and GND to the sensor) |
| Servo signal | **P2** | `servoAngle` (power the servo from 3V or its own battery, GND shared) |
| Buzzer (only if you add one) | P0 | `setupSound`, and set `soundOutput` to 2 |
| OLED SDA / SCL (optional) | P20 / P19 | the I2C pins; `oledCommand` |

Crowtail, ElecFreaks, Kitronik and similar boards route the same pins to plugs: use the plug labelled P1 for the sensor, P2 for the servo and the I2C plug for a screen.

## 3. Settings (section 1, the `on start` block)

| Setting | Meaning |
|---|---|
| `uvSensorType` | 1 = GUVA-S12SD / Crowtail / Grove / DFRobot / ElecFreaks, 2 = ML8511, 3 = sensors sold as "0–1023 = UV 0–15" |
| `uvSampleCount` | samples per reading (the middle value is used, so noise spikes are ignored) |
| `soundOutput` | 1 = micro:bit V2 speaker, 2 = buzzer on P0 |
| `servoType`, `servoRestAngle`, `servoTapAngle` | 1 = positional servo (uses the two angles), 2 = continuous rotation |
| `oledMode`, `oledType`, `oledAddress` | 0 = no screen, 1 = detect at start-up, 2 = always on; 1 = SSD1306, 2 = SH1106; 60 = 0x3C |
| `uvLowMax`, `uvHighMax`, `uvVeryHighMax` | the flowchart bands 0–2, 3–7, 8–10, 11+ (tested on the rounded UV index) |
| `waitMinutes`, `reapplyHours`, `tapMaxMinutes` | the flowchart timings: 5 minutes, 2 hours, 2 minutes |
| `alertGiveUpMinutes` | how long a flash-and-beep alert carries on with no answer before the device assumes it is not being worn and goes to standby |
| `onlineUvMaxAgeMinutes` | how long a value from the phone counts as "the phone is sending online UV" |

Cheap UV sensors are only roughly calibrated. Once it is wired up, look up today's UV index on a weather site, hold the sensor in the sun and send `cal=<that number>` (see section 5 of this file); the scale corrects itself. Send `zero` in the dark first if the reading is not 0 indoors. Calibration lives in RAM, so put the corrected numbers into `applySensorPreset` to make them permanent.

## 4. What it does (the flowchart)

![The Sunburn Flowchart](docs/sunburn-flowchart.png)

| Step | What happens |
|---|---|
| Device turns on | Tick on the LEDs, Bluetooth starts advertising as `BBC micro:bit [name]` |
| Read UV sensor | Median of 15 samples on P1 |
| Sensor reading in range? | No: cross on the LEDs, **CHECK SENSOR**, two beeps, retry in 5 s. A bad sensor is never treated as "safe" |
| Phone connected and sending online UV? | Yes while a `uv=` line arrived in the last 30 minutes: UV = the higher of sensor and online. Otherwise UV = sensor |
| 0–2 low | Happy face |
| 3–7 moderate / high | Flash and slow beep until **A**, then "1 tsp SPF 50+ on each arm, each leg, front, back and face", then the 2 hour timer starts. No **A** within 10 minutes means standby until a button is pressed |
| 8–10 very high | Flash and fast beep until **A**, the same sunscreen advice plus hat and shade, then the 2 hour timer starts |
| 11+ extreme | The servo taps the arm until **A** (after 2 minutes it beeps instead), then "Go inside now. Sunscreen on the way", then standby until any button is pressed. After standby the device reads the sensor straight away instead of waiting 5 minutes |
| Wait 5 minutes | Then back to the top. Press **A** meanwhile to see the UV index and the time until reapply on the LEDs |
| A and B held? | A+B turns the device off at any moment. A+B again turns it on |
| Reapply timer expired? | "Reapply sunscreen", then the next trip round the flowchart alerts again and starts a fresh 2 hours |

One deliberate difference from a literal reading of the chart: the flowchart re-enters the UV branch every 5 minutes, which would beep at you every 5 minutes all afternoon. So the device only alerts when sunscreen is not already on (no reapply timer running), when the band has gone up (moderate/high to very high adds the hat-and-shade advice), or when the timer has expired. While the timer is running it shows a tick and, on the OLED, the time until reapply.

| Buttons | |
|---|---|
| **A** | "Done": sunscreen is on / I am going inside. Also wakes from standby, skips the rest of a message scrolling across the LEDs, and while the device is waiting between checks shows the UV index and the sunscreen countdown |
| **B** | Wakes from standby. Hold B while switching on for **demo mode** (10 s waits, 1 minute sunscreen timer) |
| **A + B** | Device turns off / on. Bluetooth stays up so the app can turn it on again |

Without an OLED, messages scroll across the LEDs one word at a time (press A to skip the rest). With one, the screen shows the UV number large, the band, the current message, and a countdown to the next check and the next sunscreen.

## 5. Bluetooth / serial protocol (for the app or website)

The micro:bit exposes the standard **Nordic UART service** (`6E400001-B5A3-F393-E0A9-E50E24DCCA9E`, RX `…0002`, TX `…0003`). The same lines also go out over USB serial at 115200 baud, so you can test with the MakeCode console or any serial monitor before the app exists.

**Device → app**, every 2 seconds:

```
st=wait;uv=7.3;sen=7.1;onl=6.5;band=vhigh;spf=5400;spfn=3;fw=3.1;demo=0
```

| Field | Meaning |
|---|---|
| `st` | `on` `off` `reading` `error` `safe` `alert` `protected` `wait` `standby` |
| `uv` | UV index used for the decision (the higher of sensor and online) |
| `sen` / `onl` | sensor UV / online UV (`-1` = nothing received in the last 30 minutes) |
| `band` | `low` `modhigh` `vhigh` `extreme` |
| `spf` | seconds until sunscreen reapply is due (`-1` = no timer running) |
| `spfn` | sunscreen applications acknowledged since power-on |
| `fw` / `demo` | firmware version, and `1` while demo timings are on |

**Device → app**, on events: `ev=on` `ev=off` `ev=sunscreen` `ev=reapply` `ev=inside` `ev=standby` `ev=error;msg=CHECK SENSOR` (once per sensor problem, not once per retry). Logging these with a timestamp is all a website needs for daily and monthly statistics.

**App → device**, one command per line (`\n` terminated):

| Command | Effect |
|---|---|
| `uv=6.5` | Push the online UV index (0 to 20; anything else gets `err=uv`) |
| `ack` | Same as pressing A |
| `zero` / `cal=7.0` | Calibrate the sensor (dark point / known UV index) |
| `demo=1` / `demo=0` | Demo timings on / off |
| `power=0` / `power=1` | Turn off / on |
| `debug=1` / `debug=0` | Extra `dbg:` lines on the serial console (raw sensor values, commands) |
| `ping` | Replies `pong;fw=3.1;oled=1` |
| `read` | Send a status line immediately |

## 6. Quick test without any sensor

Leave P1 unconnected: the reading is noisy, so you will see the **CHECK SENSOR** path. Tie P1 to 3V for an "extreme" reading (the servo taps, then standby), or to GND for "safe". In the MakeCode console type `uv=9` to test the online path, and hold B while resetting for demo timings so the whole flowchart plays out in a few minutes.

## 7. Files

| File | What it is |
|---|---|
| `sunburn-device.mkcd` | The project to import into MakeCode (blocks, code, this README) |
| `pxt.json`, `main.ts`, `main.blocks` | The same project as a MakeCode GitHub project: settings, the program as JavaScript in section order, and the Blocks layout |
| `docs/sunburn-flowchart.pdf`, `docs/sunburn-flowchart.png` | The flowchart the program follows |
| `docs/blocks-overview.png` | The Blocks view zoomed out |

## 8. What changed

**3.1** — nothing runs on after A+B turns the device off mid-alert (the status line used to say `wait`); a bad `uv=` value is rejected instead of turning into an "extreme" alert; one `ev=error` per sensor problem instead of one every retry; A while waiting shows the UV index and countdown, and A skips a scrolling LED message; `ev=inside` is only sent when A was really pressed; an alert that nobody answers ends in standby instead of repeating every 5 minutes; the status line says whether demo timings are on; the repository can be imported straight from GitHub.

**3.0** — rewritten around the flowchart (one function per box, in order), Blocks view laid out in labelled sections, alerts only when sunscreen is not already on, numeric settings so everything is visible in `on start`, modern play-tone block.
