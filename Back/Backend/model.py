"""
KronOS ML Pipeline — RandomForestClassifier for OS Process Anomaly Detection.

Switched from IsolationForest (unsupervised, contamination mismatch) to
RandomForestClassifier (supervised) because we have labeled synthetic data.
Now uses 4 features: cpu_percent, memory_percent, disk_percent, process_count.
Outputs class label + confidence/probability score.
"""

import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import MinMaxScaler
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix, accuracy_score
import joblib
import os
from typing import Tuple, Optional


# ---------------------------------------------------------------------------
# Step 1 — Generate a synthetic 4-feature dataset with realistic distributions
# ---------------------------------------------------------------------------
def generate_dataset(num_rows: int = 5000, anomaly_ratio: float = 0.3) -> pd.DataFrame:
    """
    Build a synthetic dataset that mimics real OS metrics.
    Normal rows have moderate resource usage; anomalies have spikes in
    one or more of cpu/memory/disk or abnormal process counts.
    anomaly_ratio is kept at 0.3 (30%) — enough for the model to learn
    the anomaly boundary without drowning normal samples.
    """
    np.random.seed(42)

    num_normal = int(num_rows * (1 - anomaly_ratio))
    num_anomaly = num_rows - num_normal

    # --- Normal data ---
    normal = pd.DataFrame({
        "cpu_percent": np.random.uniform(5, 60, num_normal),
        "memory_percent": np.random.uniform(20, 65, num_normal),
        "disk_percent": np.random.uniform(30, 75, num_normal),
        "process_count": np.random.randint(80, 250, num_normal),
        "label": 1,  # 1 = Normal
    })

    # --- Anomaly data (4 different anomaly types, mixed) ---
    anomaly = pd.DataFrame({
        "cpu_percent": np.random.uniform(75, 100, num_anomaly),
        "memory_percent": np.random.uniform(70, 100, num_anomaly),
        "disk_percent": np.random.uniform(85, 100, num_anomaly),
        "process_count": np.random.randint(300, 600, num_anomaly),
        "label": 0,  # 0 = Anomaly
    })

    # Add some variety: not ALL anomalies spike on every metric
    quarter = num_anomaly // 4

    # Type A — CPU-only spike (memory/disk stay normal-ish)
    anomaly.iloc[:quarter, 1] = np.random.uniform(25, 55, quarter)     # memory normal
    anomaly.iloc[:quarter, 2] = np.random.uniform(35, 70, quarter)     # disk normal

    # Type B — Memory-only spike
    anomaly.iloc[quarter:2*quarter, 0] = np.random.uniform(10, 50, quarter)  # cpu normal
    anomaly.iloc[quarter:2*quarter, 2] = np.random.uniform(35, 70, quarter)  # disk normal

    # Type C — Disk-only spike
    anomaly.iloc[2*quarter:3*quarter, 0] = np.random.uniform(10, 50, quarter)  # cpu normal
    anomaly.iloc[2*quarter:3*quarter, 1] = np.random.uniform(25, 55, quarter)  # memory normal

    # Type D — Process-count spike (all metrics can be moderate)
    anomaly.iloc[3*quarter:, 0] = np.random.uniform(30, 70, num_anomaly - 3*quarter)
    anomaly.iloc[3*quarter:, 1] = np.random.uniform(40, 70, num_anomaly - 3*quarter)
    anomaly.iloc[3*quarter:, 2] = np.random.uniform(50, 80, num_anomaly - 3*quarter)

    df = pd.concat([normal, anomaly], ignore_index=True).sample(frac=1, random_state=42).reset_index(drop=True)
    print(f"Dataset generated: {len(df)} rows — {num_normal} normal, {num_anomaly} anomaly")
    return df


# ---------------------------------------------------------------------------
# Step 2 — Preprocess: scale features with MinMaxScaler
# ---------------------------------------------------------------------------
def preprocess_data(df: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series, MinMaxScaler]:
    """
    Separate features/labels and apply MinMaxScaler.
    Returns scaled feature DataFrame, label Series, and the fitted scaler.
    """
    feature_cols = ["cpu_percent", "memory_percent", "disk_percent", "process_count"]
    X = df[feature_cols].copy()
    y = df["label"].copy()

    scaler = MinMaxScaler()
    X[feature_cols] = scaler.fit_transform(X[feature_cols])

    print(f"Preprocessing complete — {len(feature_cols)} features scaled to [0, 1]")
    return X, y, scaler


# ---------------------------------------------------------------------------
# Step 3 — Train/test split (stratified to preserve class balance)
# ---------------------------------------------------------------------------
def split_data(X: pd.DataFrame, y: pd.Series, test_size: float = 0.2) -> tuple:
    """
    80/20 stratified split so both train and test have the same
    normal/anomaly ratio.
    """
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, stratify=y, random_state=42
    )
    print(f"Split: train={len(X_train)}, test={len(X_test)}")
    return X_train, X_test, y_train, y_test


# ---------------------------------------------------------------------------
# Step 4 — Train a RandomForestClassifier
# ---------------------------------------------------------------------------
def train_model(X_train: pd.DataFrame, y_train: pd.Series) -> RandomForestClassifier:
    """
    Supervised RandomForest with 200 trees.
    Using class_weight='balanced' to handle any residual class imbalance.
    This replaces the old IsolationForest which had a contamination
    parameter (0.1) that contradicted the 90% anomaly training data.
    """
    model = RandomForestClassifier(
        n_estimators=200,
        max_depth=15,
        class_weight="balanced",
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)
    print("RandomForestClassifier training completed.")
    return model


# ---------------------------------------------------------------------------
# Step 5 — Evaluate and print metrics
# ---------------------------------------------------------------------------
def evaluate_model(model: RandomForestClassifier, X_test: pd.DataFrame, y_test: pd.Series) -> None:
    """
    Print accuracy, confusion matrix, and per-class precision/recall/F1.
    """
    y_pred = model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)

    print(f"\nAccuracy: {acc:.4f}")
    print("\nConfusion Matrix:")
    print(confusion_matrix(y_test, y_pred))
    print("\nClassification Report:")
    print(classification_report(
        y_test, y_pred,
        target_names=["Anomaly (0)", "Normal (1)"],
        zero_division=0,
    ))


# ---------------------------------------------------------------------------
# Step 6 — Demonstrate predict_with_confidence (used by app.py at runtime)
# ---------------------------------------------------------------------------
def predict_with_confidence(
    model: RandomForestClassifier,
    scaler: MinMaxScaler,
    cpu: float,
    memory: float,
    disk: float,
    process_count: int,
) -> dict:
    """
    Single-sample prediction helper.
    Returns {'status': 'Normal'|'Anomaly', 'confidence': 0.0–1.0}.
    """
    features = np.array([[cpu, memory, disk, process_count]])
    scaled = scaler.transform(features)
    prediction = model.predict(scaled)[0]
    probabilities = model.predict_proba(scaled)[0]
    confidence = float(max(probabilities))

    status = "Normal" if prediction == 1 else "Anomaly"
    return {"status": status, "confidence": round(confidence, 4)}


# ---------------------------------------------------------------------------
# Step 7 — Save model artefacts
# ---------------------------------------------------------------------------
def save_artefacts(
    model: RandomForestClassifier,
    scaler: MinMaxScaler,
    model_path: str,
    scaler_path: str,
) -> None:
    """Persist the trained model and fitted scaler as .pkl files."""
    os.makedirs(os.path.dirname(model_path), exist_ok=True)
    joblib.dump(model, model_path)
    joblib.dump(scaler, scaler_path)
    print(f"Model saved -> {model_path}")
    print(f"Scaler saved -> {scaler_path}")


# ===========================================================================
# Main — run this file directly to regenerate model + scaler .pkl files
# ===========================================================================
if __name__ == "__main__":
    MODEL_PATH = "models/anomaly_detection_model.pkl"
    SCALER_PATH = "models/scaler.pkl"

    # Step 1: Generate dataset
    df = generate_dataset(num_rows=5000, anomaly_ratio=0.3)

    # Step 2: Preprocess
    X, y, scaler = preprocess_data(df)

    # Step 3: Split
    X_train, X_test, y_train, y_test = split_data(X, y)

    # Step 4: Train
    model = train_model(X_train, y_train)

    # Step 5: Evaluate
    evaluate_model(model, X_test, y_test)

    # Step 6: Demo prediction
    demo = predict_with_confidence(model, scaler, cpu=92.0, memory=85.0, disk=95.0, process_count=400)
    print(f"\nDemo prediction: {demo}")

    # Step 7: Save
    save_artefacts(model, scaler, MODEL_PATH, SCALER_PATH)