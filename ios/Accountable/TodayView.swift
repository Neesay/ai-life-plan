import SwiftUI

struct TodayView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var skipping: Block?
    @State private var reason = ""

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            List {
                if !AppSettings.isConfigured {
                    Section {
                        Label("Open Settings and add your server URL and token.", systemImage: "exclamationmark.triangle")
                    }
                }
                if let current = engine.currentBlock(at: context.date) {
                    Section("Now") { BlockCard(block: current, prominent: true, onAction: act) }
                }
                if let next = engine.nextBlock(at: context.date) {
                    Section("Next") { BlockCard(block: next, prominent: false, onAction: act) }
                }
                Section("Next 48 hours") {
                    if engine.blocks.isEmpty {
                        Text("Nothing planned yet.").foregroundStyle(.secondary)
                    }
                    ForEach(engine.blocks) { block in
                        BlockRow(block: block, isPast: block.endAt < context.date)
                    }
                }
                Section {
                    if let last = engine.lastSync {
                        Text("Synced \(last.formatted(.relative(presentation: .named)))")
                    }
                    if let error = engine.lastError {
                        Text(error).foregroundStyle(.red)
                    }
                    if engine.pendingEvents > 0 {
                        Text("\(engine.pendingEvents) check-ins waiting to upload").foregroundStyle(.orange)
                    }
                }
                .font(.footnote)
            }
        }
        .navigationTitle("Today")
        .refreshable { await engine.sync(reason: "pull") }
        .toolbar {
            if engine.isSyncing { ProgressView() }
        }
        .sheet(item: $skipping) { block in
            NavigationStack {
                Form {
                    Section("Why are you skipping \(block.title)?") {
                        TextField("Reason (Claude reads this)", text: $reason, axis: .vertical)
                            .lineLimit(3 ... 6)
                    }
                }
                .navigationTitle("Skip")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { skipping = nil } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Skip") {
                            let r = reason
                            skipping = nil
                            reason = ""
                            Task { await engine.checkIn(block, action: "skip", reason: r) }
                        }
                    }
                }
            }
            .presentationDetents([.medium])
        }
    }

    private func act(_ block: Block, _ action: String) {
        if action == "skip" {
            skipping = block
        } else {
            Task { await engine.checkIn(block, action: action) }
        }
    }
}

struct BlockCard: View {
    let block: Block
    let prominent: Bool
    let onAction: (Block, String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                CategoryBadge(category: block.category)
                Spacer()
                StatusBadge(status: block.status)
            }
            Text(block.title).font(prominent ? .title2.bold() : .headline)
            Text("\(block.startAt.formatted(date: .omitted, time: .shortened)) – \(block.endAt.formatted(date: .omitted, time: .shortened))")
                .foregroundStyle(.secondary)
            if block.isActive {
                HStack {
                    Button { onAction(block, "on_it") } label: { Label("On it", systemImage: "checkmark") }
                        .buttonStyle(.borderedProminent).tint(.green)
                    Button { onAction(block, "snooze") } label: { Text("+15") }
                        .buttonStyle(.bordered)
                    Button { onAction(block, "skip") } label: { Text("Skip") }
                        .buttonStyle(.bordered).tint(.red)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct BlockRow: View {
    let block: Block
    let isPast: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(block.title).strikethrough(block.status == "skipped")
                Text(block.startAt.formatted(.dateTime.weekday(.abbreviated).hour().minute()))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            StatusBadge(status: block.status)
        }
        .opacity(isPast ? 0.5 : 1)
    }
}

struct CategoryBadge: View {
    let category: String
    var body: some View {
        Text(category.uppercased())
            .font(.caption2.bold())
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(.tint.opacity(0.15), in: Capsule())
    }
}

struct StatusBadge: View {
    let status: String
    var color: Color {
        switch status {
        case "done": .green
        case "missed": .red
        case "skipped": .orange
        default: .secondary
        }
    }

    var body: some View {
        Text(status).font(.caption).foregroundStyle(color)
    }
}
