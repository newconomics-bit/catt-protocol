require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      // solc 0.8.24 defaults to the `shanghai` EVM, but OpenZeppelin 5.6.1
      // (pulled in transitively by MiningClaimer -> ECDSA/EIP712 ->
      // Bytes.sol) uses the Cancun-only `mcopy` builtin, so compiling against
      // `shanghai` fails with `DeclarationError: Function "mcopy" not found`.
      // Cancun is the correct target and is also what the Polygon deployment
      // runs on. Nothing else about the toolchain is changed.
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
      accounts: process.env.PRIVATE_KEY
        ? process.env.PRIVATE_KEY.split(",").map((k) => k.trim()).filter(Boolean)
        : [],
    },
  },
};
