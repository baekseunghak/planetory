import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import org.apache.hadoop.io.BytesWritable;
import org.apache.hadoop.io.SequenceFile;
import org.apache.hadoop.io.Text;

/** 원본 FITS 바이트를 SequenceFile에 쓰고 manifest offset으로 정확히 복원한다. */
public final class TessSequenceFileTool {
    private TessSequenceFileTool() {}

    private static String sha256(byte[] bytes) throws NoSuchAlgorithmException {
        StringBuilder value = new StringBuilder();
        for (byte item : MessageDigest.getInstance("SHA-256").digest(bytes)) {
            value.append(String.format("%02x", item));
        }
        return value.toString();
    }

    private static String json(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\"";
    }

    private static void write(String[] args) throws Exception {
        if (args.length != 7) {
            throw new IllegalArgumentException("write <input.tsv> <output.seq> <manifest.jsonl> <final-uri> <source-sha> <worker>");
        }
        java.nio.file.Path input = Paths.get(args[1]);
        Path output = new Path(args[2]);
        java.nio.file.Path manifest = Paths.get(args[3]);
        String finalUri = args[4];
        String sourceSha = args[5];
        int worker = Integer.parseInt(args[6]);
        Configuration configuration = new Configuration();
        int count = 0;
        long sourceBytes = 0;
        try (
            BufferedReader rows = Files.newBufferedReader(input, StandardCharsets.UTF_8);
            BufferedWriter manifestRows = Files.newBufferedWriter(manifest, StandardCharsets.UTF_8);
            SequenceFile.Writer writer = SequenceFile.createWriter(
                configuration,
                SequenceFile.Writer.file(output),
                SequenceFile.Writer.keyClass(Text.class),
                SequenceFile.Writer.valueClass(BytesWritable.class),
                SequenceFile.Writer.compression(SequenceFile.CompressionType.NONE)
            )
        ) {
            String row;
            while ((row = rows.readLine()) != null) {
                String[] fields = row.split("\\t", -1);
                if (fields.length != 7) throw new IOException("invalid TSV field count");
                byte[] bytes = Files.readAllBytes(Paths.get(fields[0]));
                long expectedSize = Long.parseLong(fields[4]);
                String actualSha = sha256(bytes);
                if (bytes.length != expectedSize) throw new IOException("size mismatch: " + fields[1]);
                if (!actualSha.equals(fields[5])) throw new IOException("checksum mismatch: " + fields[1]);
                long start = writer.getLength();
                writer.append(new Text(fields[1]), new BytesWritable(bytes));
                long end = writer.getLength();
                manifestRows.write(
                    "{\"filename\":" + json(fields[1])
                    + ",\"tic_id\":" + Long.parseLong(fields[2])
                    + ",\"sector\":" + Integer.parseInt(fields[3])
                    + ",\"size_bytes\":" + expectedSize
                    + ",\"sha256\":" + json(actualSha)
                    + ",\"bundle_location\":" + json(finalUri)
                    + ",\"sequence_key\":" + json(fields[1])
                    + ",\"offset_start\":" + start
                    + ",\"offset_end\":" + end
                    + ",\"input_snapshot_id\":" + json(fields[6])
                    + ",\"source_list_sha256\":" + json(sourceSha)
                    + ",\"worker_slot\":" + worker + "}\n"
                );
                count++;
                sourceBytes += bytes.length;
            }
        }
        System.out.println("SEQUENCE_WRITE_OK entries=" + count + " source_bytes=" + sourceBytes);
    }

    private static void extract(String[] args) throws Exception {
        if (args.length != 6) {
            throw new IllegalArgumentException("extract <bundle.seq> <offset> <key> <sha256> <output>");
        }
        Configuration configuration = new Configuration();
        Text key = new Text();
        BytesWritable value = new BytesWritable();
        try (SequenceFile.Reader reader = new SequenceFile.Reader(configuration, SequenceFile.Reader.file(new Path(args[1])))) {
            reader.seek(Long.parseLong(args[2]));
            if (!reader.next(key, value)) throw new IOException("record does not exist at offset");
        }
        if (!key.toString().equals(args[3])) throw new IOException("sequence key mismatch");
        byte[] bytes = new byte[value.getLength()];
        System.arraycopy(value.getBytes(), 0, bytes, 0, value.getLength());
        if (!sha256(bytes).equals(args[4])) throw new IOException("extracted checksum mismatch");
        Files.write(Paths.get(args[5]), bytes);
        System.out.println("SEQUENCE_EXTRACT_OK key=" + key + " bytes=" + bytes.length);
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) throw new IllegalArgumentException("expected write or extract");
        if (args[0].equals("write")) write(args);
        else if (args[0].equals("extract")) extract(args);
        else throw new IllegalArgumentException("unknown command: " + args[0]);
    }
}
