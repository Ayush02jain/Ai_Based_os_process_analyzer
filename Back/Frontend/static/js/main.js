/**
 * KronOS Frontend — WebSocket-driven dashboard client.
 *
 * TASK 5 changes:
 *  - Replaced setInterval+fetch polling with Socket.IO 'metrics_update' listener
 *  - Added disconnection warning badge
 *  - Processes tab: fetches /api/processes JSON, renders sortable table with live search
 *  - SVG meter structure untouched — only values are updated
 */

document.addEventListener("DOMContentLoaded", () => {

    // =====================================================================
    // DOM element references
    // =====================================================================
    const els = {
        cpu:            document.querySelector("[data-type='cpu'] .meter-progress"),
        memory:         document.querySelector("[data-type='memory'] .meter-progress"),
        disk:           document.querySelector("[data-type='disk'] .meter-progress"),
        cpuValue:       document.querySelector("[data-type='cpu'] .meter-value"),
        memoryValue:    document.querySelector("[data-type='memory'] .meter-value"),
        diskValue:      document.querySelector("[data-type='disk'] .meter-value"),
        statusBadge:    document.getElementById("status"),
        confidenceLabel:document.getElementById("confidence-label"),
        anomalyStatus:  document.getElementById("anomaly-status"),
        anomaliesList:  document.getElementById("anomalies-list"),
        suggestionsList:document.getElementById("suggestions-list"),
        connectionBadge:document.getElementById("connection-badge"),
        // Processes tab
        processSearch:  document.getElementById("process-search"),
        processLimit:   document.getElementById("process-limit"),
        processRefresh: document.getElementById("process-refresh-btn"),
        processTbody:   document.getElementById("process-tbody"),
        processTable:   document.getElementById("process-table"),
    };

    // =====================================================================
    // Section navigation (keep existing onclick handlers working)
    // =====================================================================
    window.showSection = function (sectionId) {
        document.querySelectorAll(".section").forEach(s => s.style.display = "none");
        const target = document.getElementById(sectionId);
        if (target) target.style.display = "block";

        document.querySelectorAll(".sidebar a").forEach(a => a.classList.remove("active"));
        const active = document.querySelector(`.sidebar a[onclick="showSection('${sectionId}')"]`);
        if (active) active.classList.add("active");

        // Auto-load processes when switching to that tab
        if (sectionId === "processes-section") fetchProcesses();
    };

    // =====================================================================
    // SVG meter updater — does NOT touch SVG structure, only strokeDashoffset + text
    // =====================================================================
    function updateMeter(type, value, progressCircle, textElement, status) {
        const circumference = 2 * Math.PI * 90;                       // r=90 in the SVG
        const offset = circumference - ((value || 0) / 100) * circumference;
        progressCircle.style.strokeDashoffset = offset;
        textElement.textContent = `${Math.round(value || 0)}%`;

        // Colour: red for anomaly-flagged CPU, green otherwise
        if (type === "cpu" && status === "Anomaly") {
            progressCircle.style.stroke = "#ff0000";
        } else {
            progressCircle.style.stroke = "#00ff00";
        }
    }

    // =====================================================================
    // Apply a full metrics_update payload to the dashboard
    // =====================================================================
    function applyPayload(data) {
        // --- Meters ---
        updateMeter("cpu",    data.cpu_usage,    els.cpu,    els.cpuValue,    data.status);
        updateMeter("memory", data.memory_usage, els.memory, els.memoryValue, "Normal");
        updateMeter("disk",   data.disk_usage,   els.disk,   els.diskValue,   "Normal");

        // --- Status badge ---
        els.statusBadge.textContent = data.status || "N/A";
        els.statusBadge.className   = `status-indicator ${(data.status || "normal").toLowerCase()}`;

        // --- Confidence label ---
        if (els.confidenceLabel && data.confidence !== undefined) {
            const pct = (data.confidence * 100).toFixed(1);
            els.confidenceLabel.textContent = `Confidence: ${pct}%`;
        }

        // --- Suggestions ---
        els.suggestionsList.innerHTML = "";
        const suggestions = data.suggestions || [];
        if (suggestions.length) {
            suggestions.forEach(s => {
                const li = document.createElement("li");
                li.textContent = s;
                els.suggestionsList.appendChild(li);
            });
        } else {
            els.suggestionsList.innerHTML = "<li>System is operating normally.</li>";
        }

        // --- Anomalies panel ---
        els.anomalyStatus.textContent = data.status || "N/A";
        els.anomaliesList.innerHTML = "";
        if (data.status === "Anomaly" && suggestions.length) {
            suggestions.forEach(s => {
                const li = document.createElement("li");
                li.textContent = s;
                els.anomaliesList.appendChild(li);
            });
        } else {
            els.anomaliesList.innerHTML = "<li>No anomalies detected.</li>";
        }
    }

    // =====================================================================
    // WebSocket connection (replaces REST polling)
    // =====================================================================
    const socket = io();       // connects to the same host that served the page

    // Handle incoming metrics update
    socket.on("metrics_update", (data) => {
        applyPayload(data);
    });

    // Connection status badge updates
    socket.on("connect", () => {
        els.connectionBadge.textContent = "\u25CF Connected";
        els.connectionBadge.className = "connection-badge connected";
        console.log("[WS] Connected");
    });

    socket.on("disconnect", () => {
        els.connectionBadge.textContent = "\u25CF Disconnected";
        els.connectionBadge.className = "connection-badge disconnected";
        console.warn("[WS] Disconnected");
        // Mark meters as stale
        els.statusBadge.textContent = "Disconnected";
        els.statusBadge.className = "status-indicator warning";
    });

    socket.on("connect_error", (err) => {
        els.connectionBadge.textContent = "\u25CF Reconnecting...";
        els.connectionBadge.className = "connection-badge disconnected";
        console.warn("[WS] Connect error:", err.message);
    });

    // =====================================================================
    // Processes tab — fetch /api/processes and render table
    // =====================================================================
    let currentSort = { key: "cpu_percent", asc: false };
    let processData = [];

    // Fetch process list from the REST endpoint
    async function fetchProcesses() {
        const search = els.processSearch ? els.processSearch.value : "";
        const limit  = els.processLimit  ? els.processLimit.value  : 50;
        try {
            const url = `/api/processes?search=${encodeURIComponent(search)}&limit=${limit}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            processData = await res.json();
            renderProcessTable();
        } catch (err) {
            console.error("[Processes] Fetch error:", err);
            if (els.processTbody) {
                els.processTbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#ff4444;">Error loading processes</td></tr>`;
            }
        }
    }

    // Render sorted process data into the table body
    function renderProcessTable() {
        if (!els.processTbody) return;
        const sorted = [...processData].sort((a, b) => {
            const va = a[currentSort.key] ?? "";
            const vb = b[currentSort.key] ?? "";
            if (typeof va === "number") return currentSort.asc ? va - vb : vb - va;
            return currentSort.asc
                ? String(va).localeCompare(String(vb))
                : String(vb).localeCompare(String(va));
        });

        els.processTbody.innerHTML = sorted.map(p => `
            <tr>
                <td>${p.pid}</td>
                <td>${escapeHtml(p.name)}</td>
                <td>
                    <div class="bar-container">
                        <div class="cpu-bar" style="width:${Math.min(p.cpu_percent, 100)}%"></div>
                    </div>
                    ${p.cpu_percent}%
                </td>
                <td>
                    <div class="bar-container">
                        <div class="mem-bar" style="width:${Math.min(p.memory_percent, 100)}%"></div>
                    </div>
                    ${p.memory_percent}%
                </td>
                <td>${escapeHtml(p.status)}</td>
                <td>${escapeHtml(p.username || "N/A")}</td>
            </tr>
        `).join("");
    }

    // Simple HTML-escape helper
    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str || "";
        return div.innerHTML;
    }

    // Sortable column headers
    if (els.processTable) {
        els.processTable.querySelectorAll("th[data-sort]").forEach(th => {
            th.style.cursor = "pointer";
            th.addEventListener("click", () => {
                const key = th.dataset.sort;
                if (currentSort.key === key) {
                    currentSort.asc = !currentSort.asc;
                } else {
                    currentSort = { key, asc: false };
                }
                renderProcessTable();
            });
        });
    }

    // Live search input (debounced)
    let searchTimeout;
    if (els.processSearch) {
        els.processSearch.addEventListener("input", () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(fetchProcesses, 400);
        });
    }

    // Limit dropdown change
    if (els.processLimit) {
        els.processLimit.addEventListener("change", fetchProcesses);
    }

    // Refresh button
    if (els.processRefresh) {
        els.processRefresh.addEventListener("click", fetchProcesses);
    }

    // Auto-refresh processes every 5 seconds if that tab is visible
    setInterval(() => {
        const procSection = document.getElementById("processes-section");
        if (procSection && procSection.style.display !== "none") {
            fetchProcesses();
        }
    }, 5000);
});