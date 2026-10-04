// HC-SR04 Distance Sensor -> Dashboard
// Works identically on Arduino Uno and Nano - same pins, no libraries needed.

const int TRIG_PIN = 9;   // Trigger
const int ECHO_PIN = 10;  // Echo
const int LED_PIN  = 13;  // Onboard LED (same pin on both Uno and Nano)

const unsigned long PING_INTERVAL = 1000; // 1 reading per second

unsigned long lastPingTime = 0;
unsigned long lastBlinkTime = 0;
bool ledState = false;

float currentDistance = 999.0;

void setup() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);

  Serial.begin(9600);
}

float measureDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);

  if (duration == 0) return -1; // out of range / no echo
  return (duration * 0.0343) / 2.0;
}

void loop() {
  unsigned long currentMillis = millis();

  if (currentMillis - lastPingTime >= PING_INTERVAL) {
    lastPingTime = currentMillis;
    currentDistance = measureDistanceCm();

    // IMPORTANT: this exact format is what server.js looks for.
    Serial.print("distance:");
    Serial.println(currentDistance);
  }

  // LED proximity-alert behavior
  if (currentDistance > 0 && currentDistance <= 5.0) {
    digitalWrite(LED_PIN, HIGH);
  }
  else if (currentDistance > 5.0 && currentDistance <= 50.0) {
    int blinkInterval = map((int)currentDistance, 5, 50, 80, 600);
    if (currentMillis - lastBlinkTime >= (unsigned long)blinkInterval) {
      lastBlinkTime = currentMillis;
      ledState = !ledState;
      digitalWrite(LED_PIN, ledState);
    }
  }
  else {
    digitalWrite(LED_PIN, LOW);
  }
}
