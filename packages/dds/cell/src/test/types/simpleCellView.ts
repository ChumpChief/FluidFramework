/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { requireAssignableTo } from "@fluidframework/build-tools";

import type { SimpleCell, SimpleCellView } from "../../simpleCell.js";
import type { createSimpleCell, SimpleCellFactory } from "../../simpleCellFactory.js";
import type { ReplicatedDataStructure } from "../../replicatedDataStructure.js";

type ConsumerKeys = "get" | "set" | "delete" | "empty" | "events";
type CreatedCell = ReturnType<typeof createSimpleCell>;
type CellChannel = ReturnType<SimpleCellFactory["create"]>;

declare type _implementationMatchesView = requireAssignableTo<
	SimpleCell<number>,
	SimpleCellView<number>
>;
declare type _implementationMatchesHost = requireAssignableTo<
	SimpleCell<number>,
	ReplicatedDataStructure
>;
declare type _viewHasOnlyConsumerMethods = requireAssignableTo<
	keyof SimpleCellView,
	ConsumerKeys
>;
declare type _viewHasAllConsumerMethods = requireAssignableTo<
	ConsumerKeys,
	keyof SimpleCellView
>;
declare type _createdValueIsScoped = requireAssignableTo<
	keyof CreatedCell["value"],
	ConsumerKeys
>;
declare type _createdHandleValueIsScoped = requireAssignableTo<
	keyof Awaited<ReturnType<CreatedCell["handle"]["get"]>>,
	ConsumerKeys
>;
declare type _channelEntryPointIsScoped = requireAssignableTo<
	keyof CellChannel["entryPoint"],
	ConsumerKeys
>;
declare type _channelHandleValueIsScoped = requireAssignableTo<
	keyof Awaited<ReturnType<CellChannel["handle"]["get"]>>,
	ConsumerKeys
>;
