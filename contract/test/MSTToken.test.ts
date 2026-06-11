import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("MSTToken", () => {
  async function deploy() {
    const [foundation, alice, bob] = await ethers.getSigners();
    const MST = await ethers.getContractFactory("MSTToken", foundation);
    const mst = await MST.deploy(foundation.address);
    return { mst, foundation, alice, bob };
  }

  it("has name and symbol MST", async () => {
    const { mst } = await loadFixture(deploy);
    expect(await mst.name()).to.equal("MST");
    expect(await mst.symbol()).to.equal("MST");
  });

  it("foundation (owner) is the deployer-specified address", async () => {
    const { mst, foundation } = await loadFixture(deploy);
    expect(await mst.owner()).to.equal(foundation.address);
  });

  it("only foundation can mint", async () => {
    const { mst, alice } = await loadFixture(deploy);
    await expect(
      mst.connect(alice).mint(alice.address, 1)
    ).to.be.revertedWithCustomError(mst, "OwnableUnauthorizedAccount");
  });

  it("batch mints sequential token ids starting at 1", async () => {
    const { mst, foundation, alice } = await loadFixture(deploy);
    await mst.connect(foundation).mint(alice.address, 3);
    expect(await mst.balanceOf(alice.address)).to.equal(3n);
    for (let i = 0; i < 3; i++) {
      expect(await mst.tokenOfOwnerByIndex(alice.address, i)).to.equal(BigInt(i + 1));
    }
  });

  it("continues ids across batches and recipients", async () => {
    const { mst, foundation, alice, bob } = await loadFixture(deploy);
    await mst.connect(foundation).mint(alice.address, 2); // 1,2
    await mst.connect(foundation).mint(bob.address, 2); // 3,4
    expect(await mst.tokenOfOwnerByIndex(bob.address, 0)).to.equal(3n);
    expect(await mst.tokenOfOwnerByIndex(bob.address, 1)).to.equal(4n);
    expect(await mst.totalSupply()).to.equal(4n);
  });

  it("reverts on zero quantity", async () => {
    const { mst, foundation, alice } = await loadFixture(deploy);
    await expect(
      mst.connect(foundation).mint(alice.address, 0)
    ).to.be.revertedWithCustomError(mst, "ZeroQuantity");
  });
});
