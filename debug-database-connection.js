import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

dotenv.config();

const {
  DB_HOST,
  DB_NAME,
  DB_USER,
  DB_PASS,
} = process.env;

async function testPortConnectivity(host, port) {
  return new Promise((resolve) => {
    // Try to connect to the port using nc (netcat) or telnet
    const command = `timeout 5 bash -c 'echo > /dev/tcp/${host}/${port}' 2>&1 || nc -zv -w 5 ${host} ${port} 2>&1 || echo "Port check failed"`;
    
    execPromise(command)
      .then(({ stdout, stderr }) => {
        resolve({
          reachable: stdout.includes('succeeded') || stdout.includes('open') || !stderr.includes('Connection refused'),
          output: stdout || stderr
        });
      })
      .catch((error) => {
        resolve({
          reachable: false,
          output: error.message
        });
      });
  });
}

async function testDatabaseConnection() {
  console.log("===================================");
  console.log("DATABASE CONNECTION DEBUG TEST");
  console.log("===================================\n");

  // Test credentials
  console.log("1. TESTING CREDENTIALS:");
  console.log(`   DB_HOST: ${DB_HOST || "ID313555_Xentrographics2.db.webhosting.be"}`);
  console.log(`   DB_NAME: ${DB_NAME || "ID313555_Xentrographics2"}`);
  console.log(`   DB_USER: ${DB_USER || "ID313555_Xentrographics2"}`);
  console.log(`   DB_PASS: ${DB_PASS ? "***" + DB_PASS.slice(-4) : "Dekimpen2025"}\n`);

  const connectionConfig = {
    host: DB_HOST || "ID313555_Xentrographics2.db.webhosting.be",
    database: DB_NAME || "ID313555_Xentrographics2",
    user: DB_USER || "ID313555_Xentrographics2",
    password: DB_PASS || "Dekimpen2025",
  };

  // Test DNS resolution
  console.log("2. DNS RESOLUTION TEST:");
  try {
    const { stdout } = await execPromise(`nslookup ${connectionConfig.host}`);
    const ipMatch = stdout.match(/Address:\s+(\d+\.\d+\.\d+\.\d+)/);
    if (ipMatch) {
      console.log(`   ✓ Resolved to: ${ipMatch[1]}\n`);
    } else {
      console.log(`   ✗ Could not resolve IP address\n`);
    }
  } catch (error) {
    console.log(`   ✗ DNS resolution failed\n`);
  }

  // Test port connectivity
  console.log("3. PORT CONNECTIVITY TEST (MySQL port 3306):");
  const portTest = await testPortConnectivity(connectionConfig.host, 3306);
  if (portTest.reachable) {
    console.log(`   ✓ Port 3306 is reachable`);
  } else {
    console.log(`   ✗ Port 3306 is NOT reachable`);
    console.log(`   Output: ${portTest.output}`);
    console.log(`\n   ⚠ WARNING: Cannot reach MySQL port!`);
    console.log(`   This likely means:`);
    console.log(`   - The database server is behind a firewall`);
    console.log(`   - Only specific IP addresses are whitelisted`);
    console.log(`   - Your current IP is not in the whitelist`);
    console.log(`   - This is likely normal for security reasons\n`);
  }

  console.log("4. ATTEMPTING DATABASE CONNECTION:");
  console.log(`   Host: ${connectionConfig.host}`);
  console.log(`   Database: ${connectionConfig.database}`);
  console.log(`   User: ${connectionConfig.user}\n`);

  let connection = null;

  try {
    console.log("   Connecting...");
    connection = await mysql.createConnection(connectionConfig);
    console.log("   ✓ Connection successful!\n");

    // Test 1: Simple query
    console.log("5. TEST 1: Simple query (SELECT 1)");
    const [test1] = await connection.execute("SELECT 1 as test");
    console.log(`   ✓ Result: ${JSON.stringify(test1)}\n`);

    // Test 2: Check if table exists
    console.log("6. TEST 2: Check if 'calling_campaigns' table exists");
    const [tables] = await connection.execute(
      "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = ? AND table_name = 'calling_campaigns'",
      [connectionConfig.database]
    );
    console.log(`   ✓ Tables found: ${tables[0].count}\n`);

    // Test 3: Check campaign data
    console.log("7. TEST 3: Check campaigns with temp_prompt");
    const [campaigns] = await connection.execute(
      "SELECT COUNT(*) as count FROM calling_campaigns WHERE temp_prompt IS NOT NULL"
    );
    console.log(`   ✓ Campaigns with prompt: ${campaigns[0].count}\n`);

    // Test 4: Specific campaign query (campaign 156)
    console.log("8. TEST 4: Query campaign 156 (exact query from Twilio)");
    const campaignId = 156;
    
    try {
      // Query without database prefix
      console.log(`   Query 1: SELECT FROM calling_campaigns WHERE id = ${campaignId}`);
      const [result1] = await connection.execute(
        "SELECT temp_prompt, temp_first_message FROM calling_campaigns WHERE id = ?",
        [campaignId]
      );
      console.log(`   ✓ Rows found: ${result1.length}`);
      if (result1.length > 0) {
        console.log(`   ✓ Prompt exists: ${!!result1[0].temp_prompt}`);
        console.log(`   ✓ First message exists: ${result1[0].temp_first_message !== null}`);
      }
      console.log();

      // Query with database prefix
      console.log(`   Query 2: SELECT FROM ${connectionConfig.database}.calling_campaigns WHERE id = ${campaignId}`);
      const [result2] = await connection.execute(
        `SELECT temp_prompt, temp_first_message FROM ${connectionConfig.database}.calling_campaigns WHERE id = ?`,
        [campaignId]
      );
      console.log(`   ✓ Rows found: ${result2.length}`);
      if (result2.length > 0) {
        console.log(`   ✓ Prompt exists: ${!!result2[0].temp_prompt}`);
        console.log(`   ✓ First message exists: ${result2[0].temp_first_message !== null}`);
        if (result2[0].temp_prompt) {
          console.log(`   ✓ Prompt length: ${result2[0].temp_prompt.length} chars`);
          console.log(`   ✓ Prompt preview: ${result2[0].temp_prompt.substring(0, 100)}...`);
        }
        if (result2[0].temp_first_message) {
          console.log(`   ✓ First message: ${result2[0].temp_first_message.substring(0, 100)}...`);
        }
      }
      console.log();

    } catch (queryError) {
      console.error(`   ✗ Query error: ${queryError.message}`);
      console.error(`   ✗ Error code: ${queryError.code}`);
      console.log();
    }

    // Test 5: Check other campaigns
    console.log("9. TEST 5: List all campaigns with IDs and prompt status");
    const [allCampaigns] = await connection.execute(
      "SELECT id, temp_prompt IS NOT NULL as has_prompt, temp_first_message IS NOT NULL as has_first_message FROM calling_campaigns ORDER BY id DESC LIMIT 10"
    );
    console.log(`   ✓ Found ${allCampaigns.length} campaigns:`);
    allCampaigns.forEach(c => {
      console.log(`      Campaign ${c.id}: prompt=${c.has_prompt ? 'YES' : 'NO'}, first_message=${c.has_first_message ? 'YES' : 'NO'}`);
    });
    console.log();

    // Test 6: Network connectivity test
    console.log("10. TEST 6: Network connectivity test");
    const startTime = Date.now();
    await connection.execute("SELECT 1");
    const duration = Date.now() - startTime;
    console.log(`   ✓ Query latency: ${duration}ms`);
    if (duration > 5000) {
      console.log(`   ⚠ WARNING: High latency! This could cause timeouts.`);
    }
    console.log();

  } catch (error) {
    console.error("\n===================================");
    console.error("ERROR CONNECTING TO DATABASE:");
    console.error("===================================");
    console.error(`Error code: ${error.code}`);
    console.error(`Error message: ${error.message}`);
    
    if (error.code === 'ETIMEDOUT') {
      console.error("\n⚠ ETIMEDOUT: Database connection timeout!");
      console.error("\nDit betekent dat je lokale IP-adres waarschijnlijk NIET in de whitelist staat van je hosting provider.");
      console.error("Dit is NORMALES en veilig - alleen specifieke IP's kunnen verbinden.");
      console.error("\nDe Render server HEEFT waarschijnlijk wel toegang tot de database!");
      console.error("Probleem: Als Render ook geen toegang heeft, controleer dan:");
      console.error("1. In je hosting panel: Remote MySQL whitelist");
      console.error("2. Voeg het IP-adres van Render toe aan de whitelist");
      console.error("3. Render IP-adressen kunnen variëren - check de Render docs");
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error("\n⚠ ER_ACCESS_DENIED_ERROR: Access denied!");
      console.error("   Possible causes:");
      console.error("   - Incorrect username");
      console.error("   - Incorrect password");
      console.error("   - User doesn't have permissions");
    } else if (error.code === 'ECONNREFUSED') {
      console.error("\n⚠ ECONNREFUSED: Connection refused!");
      console.error("   Possible causes:");
      console.error("   - Host is incorrect");
      console.error("   - Port is incorrect (should be 3306 for MySQL)");
      console.error("   - MySQL service not running");
    }
    console.error();
  } finally {
    if (connection) {
      await connection.end();
      console.log("11. Connection closed\n");
    }
  }

  console.log("===================================");
  console.log("DEBUG TEST COMPLETE");
  console.log("===================================");
  console.log("\nCONCLUSIE:");
  console.log("Als de database niet bereikbaar is vanaf je lokale machine,");
  console.log("maar de Render logs tonen wel ETIMEDOUT errors, dan heeft");
  console.log("Render waarschijnlijk ook geen toegang. Controleer de");
  console.log("Remote MySQL settings in je hosting control panel.\n");
}

// Run the test
testDatabaseConnection().catch(console.error);
